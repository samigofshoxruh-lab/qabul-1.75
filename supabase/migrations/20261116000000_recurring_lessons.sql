-- Повторяющийся урок это одна запись: дни недели и дата окончания. Оплата помесячная.
-- Посещаемость повторяющегося урока отмечается по датам.

alter table public.lessons
  add column repeat_days smallint[] not null default '{}'
    check (cardinality(repeat_days) <= 7 and repeat_days <@ array[1, 2, 3, 4, 5, 6, 7]::smallint[]),
  add column repeat_until date;

grant update (title, starts_at, duration_minutes, notes, price, remind, teacher, room, cancelled_at, cancel_reason, repeat_days, repeat_until)
  on public.lessons to authenticated;

-- Ближайшее занятие после p_from (по Ташкенту). У обычного урока это его время, у повторяющегося
-- следующий нужный день недели до даты окончания. Закончился: null.
create function private.lesson_next_start(
  p_start timestamptz, p_days smallint[], p_until date, p_from timestamptz default now()
) returns timestamptz
language plpgsql stable set search_path = pg_catalog as $$
declare
  v_local timestamp := p_start at time zone 'Asia/Tashkent';
  v_day date;
  v_candidate timestamptz;
begin
  if coalesce(cardinality(p_days), 0) = 0 then
    return p_start;
  end if;
  v_day := greatest(v_local::date, (p_from at time zone 'Asia/Tashkent')::date);
  for i in 0..400 loop
    exit when p_until is not null and v_day > p_until;
    if extract(isodow from v_day)::smallint = any (p_days) then
      v_candidate := (v_day + v_local::time) at time zone 'Asia/Tashkent';
      if v_candidate > p_from and v_candidate >= p_start then
        return v_candidate;
      end if;
    end if;
    v_day := v_day + 1;
  end loop;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Помесячная оплата: долг = (цена в месяц - скидка) * число начисленных месяцев - оплачено
-- ---------------------------------------------------------------------------

alter table public.lesson_students add column months_billed integer not null default 1 check (months_billed >= 1);

alter table public.lesson_students drop column debt;
alter table public.lesson_students
  add column debt bigint generated always as (greatest((price - discount) * months_billed - paid, 0)) stored;

-- Сколько месяцев начислено ученику: с месяца записи (или начала занятий) по текущий,
-- но не дальше месяца окончания. Обычный урок оплачивается один раз.
create function private.billing_months(p_days smallint[], p_start timestamptz, p_until date, p_joined timestamptz) returns integer
language sql stable set search_path = pg_catalog as $$
  select case
    when coalesce(cardinality(p_days), 0) = 0 then 1
    else greatest(1, (
      (extract(year from e.m) - extract(year from s.m)) * 12 + extract(month from e.m) - extract(month from s.m)
    )::integer + 1)
  end
  from (select date_trunc('month', greatest(p_joined, p_start) at time zone 'Asia/Tashkent') as m) s,
       (select date_trunc('month', least(
          now() at time zone 'Asia/Tashkent',
          coalesce(p_until::timestamp, now() at time zone 'Asia/Tashkent')
        )) as m) e;
$$;

create function private.refresh_billing(p_workspace uuid default null, p_lesson uuid default null) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.lesson_students s
  set months_billed = private.billing_months(l.repeat_days, l.starts_at, l.repeat_until, s.created_at)
  from public.lessons l
  where l.id = s.lesson_id
    and (p_workspace is null or s.workspace_id = p_workspace)
    and (p_lesson is null or s.lesson_id = p_lesson)
    and s.months_billed is distinct from private.billing_months(l.repeat_days, l.starts_at, l.repeat_until, s.created_at);
$$;

-- Сайт вызывает при открытии оплат, так что цифры свежие, даже если ночное обновление не запускалось.
create function public.refresh_billing(p_workspace uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_member(p_workspace) then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  perform private.refresh_billing(p_workspace, null);
end;
$$;

create function private.lesson_billing_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform private.refresh_billing(null, new.id);
  return null;
end;
$$;
create trigger lessons_billing after update of repeat_days, repeat_until, starts_at on public.lessons
  for each row execute function private.lesson_billing_trigger();

create function private.student_billing_trigger() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  new.months_billed := coalesce((
    select private.billing_months(l.repeat_days, l.starts_at, l.repeat_until, coalesce(new.created_at, now()))
    from public.lessons l where l.id = new.lesson_id
  ), 1);
  return new;
end;
$$;
create trigger lesson_students_billing before insert on public.lesson_students
  for each row execute function private.student_billing_trigger();

-- ---------------------------------------------------------------------------
-- Посещаемость повторяющегося урока по датам
-- ---------------------------------------------------------------------------

create table public.lesson_attendance (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  lesson_id uuid not null references public.lessons (id) on delete cascade,
  student_id uuid not null references public.lesson_students (id) on delete cascade,
  day date not null,
  attended boolean not null,
  unique (student_id, day)
);
create index lesson_attendance_lesson_idx on public.lesson_attendance (lesson_id, day);
alter table public.lesson_attendance enable row level security;
create policy lesson_attendance_select on public.lesson_attendance for select to authenticated
  using (private.is_member(workspace_id));
revoke all on public.lesson_attendance from anon, authenticated, public;
grant all on public.lesson_attendance to service_role;
grant select on public.lesson_attendance to authenticated;

-- Отметить пришёл, не пришёл или снять отметку (null) за конкретный день.
create function public.lesson_set_attendance(p_student uuid, p_day date, p_attended boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_student public.lesson_students;
begin
  select * into v_student from public.lesson_students where id = p_student;
  if not found or not private.is_member(v_student.workspace_id) then
    raise exception 'Ученик не найден' using errcode = '42501';
  end if;
  if p_attended is null then
    delete from public.lesson_attendance where student_id = p_student and day = p_day;
  else
    insert into public.lesson_attendance (workspace_id, lesson_id, student_id, day, attended)
    values (v_student.workspace_id, v_student.lesson_id, p_student, p_day, p_attended)
    on conflict (student_id, day) do update set attended = excluded.attended;
  end if;
end;
$$;

-- Напоминания идут перед ближайшим занятием повторяющегося урока.
create or replace function public.lesson_reminders_claim(p_limit integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  r record;
  v_reminder uuid;
  v_lead uuid;
  v_message uuid;
  v_text text;
  v_out jsonb := '[]'::jsonb;
begin
  -- Функцию могли прервать на середине: такие сообщения не должны висеть как «Отправляется…».
  update public.messages m set status = 'failed', error = 'Напоминание не удалось отправить'
  from public.lesson_reminders x
  where x.message_id = m.id and m.status = 'queued' and m.created_at < now() - interval '15 minutes';

  for r in
    select
      s.id as student_id, s.contact_id, l.workspace_id, l.title, n.next_start as starts_at, k.kind,
      ct.channel_id, ct.external_id, ct.meta,
      ch.platform, ch.name as channel_name, ch.is_active, ch.deleted_at
    from public.lesson_students s
    join public.lessons l on l.id = s.lesson_id
    join public.workspaces w on w.id = l.workspace_id
    join public.contacts ct on ct.id = s.contact_id
    join public.channels ch on ch.id = ct.channel_id
    cross join lateral (select private.lesson_next_start(l.starts_at, l.repeat_days, l.repeat_until) as next_start) n
    cross join lateral (values ('day'), ('hour')) as k(kind)
    where l.remind
      and n.next_start > now()
      and s.attended is distinct from false
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
      and (
        (k.kind = 'hour' and n.next_start <= now() + interval '1 hour')
        -- Если до урока меньше трёх часов, хватит одного напоминания за час.
        or (k.kind = 'day' and n.next_start <= now() + interval '24 hours' and n.next_start > now() + interval '3 hours')
      )
      and not exists (
        select 1 from public.lesson_reminders x
        where x.student_id = s.id and x.kind = k.kind and x.starts_at = n.next_start
      )
    order by n.next_start
    limit greatest(p_limit, 1)
  loop
    insert into public.lesson_reminders (workspace_id, student_id, kind, starts_at)
    values (r.workspace_id, r.student_id, r.kind, r.starts_at)
    on conflict (student_id, kind, starts_at) do nothing
    returning id into v_reminder;
    continue when v_reminder is null;

    if r.deleted_at is not null or not r.is_active then
      update public.lesson_reminders
      set error = case when r.deleted_at is not null then 'Канал отключён' else 'В этом канале выключен бот' end
      where id = v_reminder;
      continue;
    end if;

    select id into v_lead from public.leads where contact_id = r.contact_id order by created_at desc limit 1;
    if v_lead is null then
      update public.lesson_reminders set error = 'У клиента нет заявки' where id = v_reminder;
      continue;
    end if;

    v_text := case r.kind
      when 'day' then 'Напоминаем: ' || private.lesson_when(r.starts_at) || ' урок «' || r.title || '». Ждём вас!'
      else 'Скоро начало: ' || private.lesson_when(r.starts_at) || ' урок «' || r.title || '». Ждём вас!'
    end;

    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, status)
    values (r.workspace_id, v_lead, r.channel_id, 'out', 'bot', v_text, 'queued')
    returning id into v_message;

    update public.lesson_reminders set message_id = v_message where id = v_reminder;

    v_out := v_out || jsonb_build_object(
      'message_id', v_message,
      'text', v_text,
      'channel_id', r.channel_id,
      'platform', r.platform,
      'channel_name', r.channel_name,
      'external_id', r.external_id,
      'meta', r.meta
    );
  end loop;

  return v_out;
end;
$$;


-- ---------------------------------------------------------------------------
-- Прежние «серии» (по одной строке на каждое занятие) склеиваем в один урок.
-- Оплаты и ученики переносятся в первый урок серии, лишние строки удаляются.
-- ---------------------------------------------------------------------------

create function private.merge_lesson_series() returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s record;
  o record;
  st record;
  v_base uuid;
  v_target uuid;
  v_merged integer := 0;
begin
  for s in
    select series_id, workspace_id from public.lessons
    where series_id is not null and cardinality(repeat_days) = 0
    group by series_id, workspace_id
    having count(*) > 1
  loop
    select id into v_base from public.lessons
    where series_id = s.series_id and starts_at is not null
    order by starts_at limit 1;
    continue when v_base is null;

    update public.lessons b set
      repeat_days = coalesce((
        select array_agg(distinct extract(isodow from x.starts_at at time zone 'Asia/Tashkent')::smallint order by extract(isodow from x.starts_at at time zone 'Asia/Tashkent')::smallint)
        from public.lessons x where x.series_id = s.series_id and x.starts_at is not null
      ), '{}'),
      repeat_until = (select max(x.starts_at at time zone 'Asia/Tashkent')::date from public.lessons x where x.series_id = s.series_id)
    where b.id = v_base;

    for o in select id from public.lessons where series_id = s.series_id and id <> v_base loop
      for st in select * from public.lesson_students where lesson_id = o.id loop
        select t.id into v_target from public.lesson_students t
        where t.lesson_id = v_base
          and ((st.contact_id is not null and t.contact_id = st.contact_id)
            or (st.contact_id is null and t.contact_id is null and lower(t.name) = lower(st.name) and coalesce(t.phone, '') = coalesce(st.phone, '')))
        limit 1;
        if v_target is null then
          update public.lesson_students set lesson_id = v_base where id = st.id;
        else
          update public.payments set student_id = v_target where student_id = st.id;
          delete from public.lesson_students where id = st.id;
        end if;
      end loop;
      delete from public.lessons where id = o.id;
      v_merged := v_merged + 1;
    end loop;
    perform private.refresh_billing(null, v_base);
  end loop;
  return v_merged;
end;
$$;

select private.merge_lesson_series();
select private.refresh_billing(null, null);

revoke all on function
  public.lesson_reminders_claim(integer),
  public.refresh_billing(uuid),
  public.lesson_set_attendance(uuid, date, boolean)
from anon, authenticated, public;
revoke all on function
  private.lesson_next_start(timestamptz, smallint[], date, timestamptz),
  private.billing_months(smallint[], timestamptz, date, timestamptz),
  private.refresh_billing(uuid, uuid),
  private.lesson_billing_trigger(),
  private.student_billing_trigger(),
  private.merge_lesson_series()
from anon, authenticated, public;
grant execute on function public.refresh_billing(uuid), public.lesson_set_attendance(uuid, date, boolean) to authenticated, service_role;
grant execute on function public.lesson_reminders_claim(integer) to service_role;

-- Раз в сутки (00:10 по Ташкенту) начисляем новый месяц повторяющимся урокам.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    perform cron.schedule('qabul-billing', '10 19 * * *', $job$select private.refresh_billing(null, null)$job$);
  end if;
exception when others then
  null;
end;
$$;
