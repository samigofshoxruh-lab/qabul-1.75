-- Права сотрудников, поля заявок (напоминание, теги, источник), массовые действия,
-- преподаватель и кабинет в уроках, отмена урока, группы учеников, сообщения о переносе.

-- ---------------------------------------------------------------------------
-- Права сотрудников
-- ---------------------------------------------------------------------------

alter table public.workspace_members
  add column can_view_payments boolean not null default true,
  add column can_edit_survey boolean not null default false;

create function private.can_view_payments(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace and user_id = auth.uid()
      and (role = 'owner' or can_view_payments)
  );
$$;

create function private.can_edit_survey(p_workspace uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace and user_id = auth.uid()
      and (role = 'owner' or can_edit_survey)
  );
$$;

revoke all on function private.can_view_payments(uuid), private.can_edit_survey(uuid) from public;
grant execute on function private.can_view_payments(uuid), private.can_edit_survey(uuid) to authenticated, service_role;

-- Платежи видит только тот, кому разрешили.
drop policy payments_select on public.payments;
drop policy payments_insert on public.payments;
drop policy payments_update on public.payments;
drop policy payments_delete on public.payments;
create policy payments_select on public.payments for select to authenticated
  using (private.can_view_payments(workspace_id));
create policy payments_insert on public.payments for insert to authenticated
  with check (
    private.can_view_payments(workspace_id)
    and exists (select 1 from public.lesson_students s where s.id = student_id and s.workspace_id = payments.workspace_id)
  );
create policy payments_update on public.payments for update to authenticated
  using (private.can_view_payments(workspace_id)) with check (private.can_view_payments(workspace_id));
create policy payments_delete on public.payments for delete to authenticated
  using (private.can_view_payments(workspace_id));

-- Анкету правит владелец и сотрудник с правом.
drop policy surveys_insert on public.surveys;
drop policy surveys_update on public.surveys;
drop policy surveys_delete on public.surveys;
create policy surveys_insert on public.surveys for insert to authenticated
  with check (private.can_edit_survey(workspace_id));
create policy surveys_update on public.surveys for update to authenticated
  using (private.can_edit_survey(workspace_id)) with check (private.can_edit_survey(workspace_id));
create policy surveys_delete on public.surveys for delete to authenticated
  using (private.can_edit_survey(workspace_id) and not is_default);

drop policy questions_insert on public.questions;
drop policy questions_update on public.questions;
drop policy questions_delete on public.questions;
create policy questions_insert on public.questions for insert to authenticated
  with check (exists (select 1 from public.surveys s where s.id = survey_id and private.can_edit_survey(s.workspace_id)));
create policy questions_update on public.questions for update to authenticated
  using (exists (select 1 from public.surveys s where s.id = survey_id and private.can_edit_survey(s.workspace_id)))
  with check (exists (select 1 from public.surveys s where s.id = survey_id and private.can_edit_survey(s.workspace_id)));
create policy questions_delete on public.questions for delete to authenticated
  using (exists (select 1 from public.surveys s where s.id = survey_id and private.can_edit_survey(s.workspace_id)));

create function public.set_member_permissions(
  p_workspace uuid, p_user uuid, p_view_payments boolean, p_edit_survey boolean
) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.is_owner(p_workspace) then
    raise exception 'Права выдаёт только владелец компании' using errcode = '42501';
  end if;
  update public.workspace_members
  set can_view_payments = p_view_payments, can_edit_survey = p_edit_survey
  where workspace_id = p_workspace and user_id = p_user and role = 'admin';
  if not found then
    raise exception 'Сотрудник не найден' using errcode = 'P0002';
  end if;
end;
$$;

-- Права видны сайту вместе с остальным доступом.
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'is_platform_admin', exists (select 1 from public.platform_admins where user_id = auth.uid()),
    'memberships', coalesce((
      select jsonb_agg(jsonb_build_object(
        'workspace_id', w.id,
        'name', w.name,
        'role', m.role,
        'access_until', least(w.access_until, m.access_until),
        'is_suspended', w.is_suspended,
        'active', not w.is_suspended
          and (w.access_until is null or w.access_until > now())
          and (m.access_until is null or m.access_until > now()),
        'can_view_payments', m.role = 'owner' or m.can_view_payments,
        'can_edit_survey', m.role = 'owner' or m.can_edit_survey
      ) order by m.created_at)
      from public.workspace_members m
      join public.workspaces w on w.id = m.workspace_id
      where m.user_id = auth.uid()
    ), '[]'::jsonb)
  );
$$;

-- ---------------------------------------------------------------------------
-- Заявки: напоминание вернуться, теги, источник
-- ---------------------------------------------------------------------------

alter table public.leads
  add column follow_up_at timestamptz,
  add column tags text[] not null default '{}' check (cardinality(tags) <= 10),
  add column source text check (length(source) <= 60);

create index leads_follow_up_idx on public.leads (workspace_id, follow_up_at)
  where follow_up_at is not null and status in ('new', 'in_work');

-- Источник по умолчанию: сам канал. Дальше его можно уточнить (ссылка бота с меткой, ручная правка).
create function private.lead_default_source() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.source is null then
    select platform into new.source from public.channels where id = new.channel_id;
  end if;
  return new;
end;
$$;
create trigger leads_default_source before insert on public.leads
  for each row execute function private.lead_default_source();

update public.leads l set source = c.platform from public.channels c where c.id = l.channel_id and l.source is null;

create function public.set_lead_follow_up(p_lead_id uuid, p_at timestamptz) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.leads set follow_up_at = p_at
  where id = p_lead_id and private.is_member(workspace_id);
$$;

create function public.set_lead_tags(p_lead_id uuid, p_tags text[]) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tags text[];
begin
  select coalesce(array_agg(t order by first_pos), '{}')
  into v_tags
  from (
    select left(btrim(x), 30) as t, min(ord) as first_pos
    from unnest(coalesce(p_tags, '{}')) with ordinality as u(x, ord)
    where btrim(x) <> ''
    group by left(btrim(x), 30)
    order by min(ord)
    limit 10
  ) s;
  update public.leads set tags = v_tags
  where id = p_lead_id and private.is_member(workspace_id);
end;
$$;

create function public.set_lead_source(p_lead_id uuid, p_source text) returns void
language sql security definer set search_path = public, pg_temp as $$
  update public.leads set source = nullif(left(btrim(coalesce(p_source, '')), 60), '')
  where id = p_lead_id and private.is_member(workspace_id);
$$;

-- Массово закрыть или вернуть в новые. Что не получилось (например, у клиента уже есть открытая заявка), пропускается.
create function public.bulk_set_status(p_lead_ids uuid[], p_status text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id uuid;
  v_done integer := 0;
begin
  if coalesce(cardinality(p_lead_ids), 0) > 200 then
    raise exception 'Не больше 200 заявок за раз' using errcode = '22023';
  end if;
  foreach v_id in array coalesce(p_lead_ids, '{}') loop
    begin
      perform public.set_lead_status(v_id, p_status);
      v_done := v_done + 1;
    exception when others then
      null;
    end;
  end loop;
  return v_done;
end;
$$;

-- Назначить ответственного сразу нескольким заявкам.
create function public.bulk_assign(p_lead_ids uuid[], p_user uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
  v_done integer := 0;
begin
  if coalesce(cardinality(p_lead_ids), 0) > 200 then
    raise exception 'Не больше 200 заявок за раз' using errcode = '22023';
  end if;
  select workspace_id into v_workspace from public.leads where id = p_lead_ids[1];
  if v_workspace is null or not private.is_member(v_workspace) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_members where workspace_id = v_workspace and user_id = p_user) then
    raise exception 'Сотрудник не найден' using errcode = 'P0002';
  end if;
  update public.leads set
    assigned_to = p_user,
    status = 'in_work',
    taken_at = coalesce(taken_at, now()),
    completed_at = coalesce(completed_at, now()),
    current_question_id = null
  where id = any (p_lead_ids)
    and workspace_id = v_workspace
    and status in ('new', 'in_work');
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

-- Какой источник и тег приносит больше заявок и сколько из них завершены.
create function public.lead_stats(p_workspace uuid, p_from timestamptz, p_to timestamptz) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not private.is_member(p_workspace) then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'by_source', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'total', s.total, 'done', s.done) order by s.total desc)
      from (
        select coalesce(source, 'без источника') as name, count(*) as total, count(*) filter (where status = 'done') as done
        from public.leads
        where workspace_id = p_workspace and created_at >= p_from and created_at < p_to
        group by 1
      ) s
    ), '[]'::jsonb),
    'by_tag', coalesce((
      select jsonb_agg(jsonb_build_object('name', s.name, 'total', s.total, 'done', s.done) order by s.total desc)
      from (
        select t as name, count(*) as total, count(*) filter (where l.status = 'done') as done
        from public.leads l, unnest(l.tags) t
        where l.workspace_id = p_workspace and l.created_at >= p_from and l.created_at < p_to
        group by t
      ) s
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Уроки: преподаватель, кабинет, отмена, серия повторяющихся уроков
-- ---------------------------------------------------------------------------

alter table public.lessons
  add column teacher text check (length(teacher) <= 120),
  add column room text check (length(room) <= 60),
  add column series_id uuid,
  add column cancelled_at timestamptz,
  add column cancel_reason text check (length(cancel_reason) <= 300);
create index lessons_series_idx on public.lessons (series_id) where series_id is not null;

grant update (title, starts_at, duration_minutes, notes, price, remind, teacher, room, cancelled_at, cancel_reason)
  on public.lessons to authenticated;

-- Отменённому уроку напоминания не шлём.
create function private.lesson_cancelled() returns trigger
language plpgsql as $$
begin
  if new.cancelled_at is not null then
    new.remind := false;
  end if;
  return new;
end;
$$;
create trigger lessons_cancelled before insert or update of cancelled_at on public.lessons
  for each row execute function private.lesson_cancelled();

-- ---------------------------------------------------------------------------
-- Группы учеников
-- ---------------------------------------------------------------------------

create table public.student_groups (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 80),
  created_at timestamptz not null default now(),
  unique (workspace_id, name)
);

create table public.student_group_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  group_id uuid not null references public.student_groups (id) on delete cascade,
  contact_id uuid references public.contacts (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 200),
  phone text check (length(phone) <= 40),
  created_at timestamptz not null default now(),
  unique (group_id, contact_id)
);
create index student_group_members_group_idx on public.student_group_members (group_id);

alter table public.student_groups enable row level security;
alter table public.student_group_members enable row level security;

create policy student_groups_all on public.student_groups for all to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy student_group_members_select on public.student_group_members for select to authenticated
  using (private.is_member(workspace_id));
create policy student_group_members_insert on public.student_group_members for insert to authenticated
  with check (
    private.is_member(workspace_id)
    and exists (select 1 from public.student_groups g where g.id = group_id and g.workspace_id = student_group_members.workspace_id)
    and (contact_id is null or exists (
      select 1 from public.contacts c where c.id = contact_id and c.workspace_id = student_group_members.workspace_id
    ))
  );
create policy student_group_members_delete on public.student_group_members for delete to authenticated
  using (private.is_member(workspace_id));

revoke all on public.student_groups, public.student_group_members from anon, authenticated, public;
grant all on public.student_groups, public.student_group_members to service_role;
grant select, insert, delete on public.student_groups, public.student_group_members to authenticated;
grant update (name) on public.student_groups to authenticated;

-- Всю группу в урок одной кнопкой. Кто уже записан, пропускается.
create function public.lesson_add_group(p_lesson uuid, p_group uuid) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
  v_added integer;
begin
  select workspace_id into v_workspace from public.lessons where id = p_lesson;
  if v_workspace is null or not private.is_member(v_workspace)
     or not exists (select 1 from public.student_groups where id = p_group and workspace_id = v_workspace) then
    raise exception 'Урок или группа не найдены' using errcode = '42501';
  end if;

  insert into public.lesson_students (workspace_id, lesson_id, contact_id, name, phone)
  select v_workspace, p_lesson, m.contact_id, m.name, m.phone
  from public.student_group_members m
  where m.group_id = p_group
    and not exists (
      select 1 from public.lesson_students s
      where s.lesson_id = p_lesson
        and (
          (m.contact_id is not null and s.contact_id = m.contact_id)
          or (m.contact_id is null and s.contact_id is null and lower(s.name) = lower(m.name) and coalesce(s.phone, '') = coalesce(m.phone, ''))
        )
    );
  get diagnostics v_added = row_count;
  return v_added;
end;
$$;

-- ---------------------------------------------------------------------------
-- Сообщение ученикам о переносе или отмене урока
-- ---------------------------------------------------------------------------

create function public.lesson_notify_prepare(
  p_lesson uuid, p_user uuid, p_kind text, p_old_starts_at timestamptz default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lesson public.lessons;
  r record;
  v_lead uuid;
  v_message uuid;
  v_text text;
  v_out jsonb := '[]'::jsonb;
  v_skipped integer := 0;
begin
  select * into v_lesson from public.lessons where id = p_lesson;
  if not found or not exists (
    select 1 from public.workspace_members where workspace_id = v_lesson.workspace_id and user_id = p_user
  ) then
    raise exception 'Урок не найден' using errcode = '42501';
  end if;
  if p_kind not in ('moved', 'cancelled') then
    raise exception 'Неизвестный вид сообщения' using errcode = '22023';
  end if;

  v_text := case p_kind
    when 'moved' then
      'Урок «' || v_lesson.title || '» перенесён' ||
      case when p_old_starts_at is not null then ' с ' || private.lesson_when(p_old_starts_at) else '' end ||
      case when v_lesson.starts_at is not null then ' на ' || private.lesson_when(v_lesson.starts_at) else '' end ||
      '. Ждём вас!'
    else
      'Урок «' || v_lesson.title || '»' ||
      case when coalesce(p_old_starts_at, v_lesson.starts_at) is not null
           then ' (' || private.lesson_when(coalesce(p_old_starts_at, v_lesson.starts_at)) || ')' else '' end ||
      ' отменён.' ||
      case when nullif(btrim(coalesce(v_lesson.cancel_reason, '')), '') is not null then ' Причина: ' || v_lesson.cancel_reason || '.' else '' end ||
      ' Мы сообщим о новом времени.'
  end;

  for r in
    select s.id as student_id, s.contact_id, ct.channel_id, ct.external_id, ct.meta,
           ch.platform, ch.name as channel_name, ch.is_active, ch.deleted_at
    from public.lesson_students s
    left join public.contacts ct on ct.id = s.contact_id
    left join public.channels ch on ch.id = ct.channel_id
    where s.lesson_id = p_lesson and s.attended is distinct from false
  loop
    if r.contact_id is null or r.deleted_at is not null or r.is_active is not true then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    select id into v_lead from public.leads where contact_id = r.contact_id order by created_at desc limit 1;
    if v_lead is null then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, agent_id, text, status)
    values (v_lesson.workspace_id, v_lead, r.channel_id, 'out', 'agent', p_user, v_text, 'queued')
    returning id into v_message;
    v_out := v_out || jsonb_build_object(
      'message_id', v_message, 'text', v_text, 'channel_id', r.channel_id,
      'platform', r.platform, 'channel_name', r.channel_name,
      'external_id', r.external_id, 'meta', r.meta
    );
  end loop;

  return jsonb_build_object('messages', v_out, 'skipped', v_skipped);
end;
$$;

revoke all on function
  public.set_member_permissions(uuid, uuid, boolean, boolean),
  public.set_lead_follow_up(uuid, timestamptz),
  public.set_lead_tags(uuid, text[]),
  public.set_lead_source(uuid, text),
  public.bulk_set_status(uuid[], text),
  public.bulk_assign(uuid[], uuid),
  public.lead_stats(uuid, timestamptz, timestamptz),
  public.lesson_add_group(uuid, uuid),
  public.lesson_notify_prepare(uuid, uuid, text, timestamptz),
  public.my_access()
from anon, authenticated, public;
revoke all on function
  private.lead_default_source(),
  private.lesson_cancelled()
from anon, authenticated, public;

grant execute on function
  public.set_member_permissions(uuid, uuid, boolean, boolean),
  public.set_lead_follow_up(uuid, timestamptz),
  public.set_lead_tags(uuid, text[]),
  public.set_lead_source(uuid, text),
  public.bulk_set_status(uuid[], text),
  public.bulk_assign(uuid[], uuid),
  public.lead_stats(uuid, timestamptz, timestamptz),
  public.lesson_add_group(uuid, uuid),
  public.my_access()
to authenticated, service_role;
-- Сообщение о переносе готовит только Edge Function под ключом сервиса.
grant execute on function public.lesson_notify_prepare(uuid, uuid, text, timestamptz) to service_role;
