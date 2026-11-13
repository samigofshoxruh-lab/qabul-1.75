-- Поддержка: вложения, статус обращения, шаблоны ответов, уведомление главному админу в Telegram.

alter table public.support_messages
  add column attachment_path text check (length(attachment_path) <= 300),
  add column attachment_name text check (length(attachment_name) <= 200),
  add column notified_at timestamptz;

-- Старые сообщения уже видны на сайте: в Telegram о них писать не нужно.
update public.support_messages set notified_at = now();

-- ---------------------------------------------------------------------------
-- Статус обращения
-- ---------------------------------------------------------------------------

create table public.support_thread_state (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'resolved')),
  updated_at timestamptz not null default now()
);
alter table public.support_thread_state enable row level security;
create policy support_state_select on public.support_thread_state for select to authenticated
  using (private.is_owner_any_term(workspace_id) or private.is_platform_admin());
revoke all on public.support_thread_state from anon, authenticated, public;
grant all on public.support_thread_state to service_role;
grant select on public.support_thread_state to authenticated;

create function public.support_set_status(p_workspace uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_status not in ('open', 'resolved') then
    raise exception 'Неизвестный статус' using errcode = '22023';
  end if;
  if not (private.is_platform_admin() or private.is_owner_any_term(p_workspace)) then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  insert into public.support_thread_state (workspace_id, status) values (p_workspace, p_status)
  on conflict (workspace_id) do update set status = excluded.status, updated_at = now();
end;
$$;

-- Новое сообщение владельца снова открывает обращение и зовёт главного админа в Telegram.
create function private.support_after_insert() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.support_thread_state (workspace_id, status) values (new.workspace_id, 'open')
  on conflict (workspace_id) do update set status = 'open', updated_at = now()
  where public.support_thread_state.status <> 'open' and new.sender = 'owner';
  if new.sender = 'owner' then
    begin
      perform private.call_edge_function('support-notify');
    exception when others then
      -- Telegram не настроен или недоступен: сообщение всё равно сохранено, повторим по расписанию.
      null;
    end;
  end if;
  return null;
end;
$$;
create trigger support_messages_after_insert after insert on public.support_messages
  for each row execute function private.support_after_insert();

-- ---------------------------------------------------------------------------
-- Отправка с вложением
-- ---------------------------------------------------------------------------

drop function public.support_send(uuid, text, boolean);
create function public.support_send(
  p_workspace uuid, p_text text, p_as_platform boolean default false,
  p_attachment_path text default null, p_attachment_name text default null
) returns uuid
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_text text := btrim(coalesce(p_text, ''));
  v_id uuid;
begin
  if p_as_platform then
    if not private.is_platform_admin() then
      raise exception 'Нет доступа' using errcode = '42501';
    end if;
  elsif not private.is_owner_any_term(p_workspace) then
    raise exception 'Писать в поддержку может только владелец компании' using errcode = '42501';
  end if;

  if v_text = '' and p_attachment_path is not null then
    v_text := 'Вложение';
  end if;
  if v_text = '' or length(v_text) > 4000 then
    raise exception 'Напишите сообщение длиной до 4000 символов' using errcode = '22023';
  end if;
  -- Файл должен лежать в папке этой компании, чужой файл прикрепить нельзя.
  if p_attachment_path is not null and p_attachment_path not like p_workspace::text || '/%' then
    raise exception 'Некорректное вложение' using errcode = '22023';
  end if;

  insert into public.support_messages (workspace_id, sender, author_id, author_email, text, attachment_path, attachment_name)
  values (
    p_workspace,
    case when p_as_platform then 'platform' else 'owner' end,
    auth.uid(),
    (select email from auth.users where id = auth.uid()),
    v_text,
    p_attachment_path,
    left(p_attachment_name, 200)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Список обращений теперь со статусом.
create or replace function public.platform_support_threads() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not private.is_platform_admin() then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;

  return coalesce((
    select jsonb_agg(t order by t.last_at desc)
    from (
      select
        w.id as workspace_id,
        w.name,
        max(m.created_at) as last_at,
        (array_agg(m.text order by m.created_at desc))[1] as last_text,
        (array_agg(m.sender order by m.created_at desc))[1] as last_sender,
        count(*) filter (where m.sender = 'owner' and m.read_at is null) as unread,
        coalesce(max(s.status), 'open') as status
      from public.workspaces w
      join public.support_messages m on m.workspace_id = w.id
      left join public.support_thread_state s on s.workspace_id = w.id
      group by w.id, w.name
    ) t
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Быстрые ответы главного админа
-- ---------------------------------------------------------------------------

create table public.support_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(btrim(title)) between 1 and 60),
  text text not null check (length(btrim(text)) between 1 and 4000),
  created_at timestamptz not null default now()
);
alter table public.support_templates enable row level security;
create policy support_templates_all on public.support_templates for all to authenticated
  using (private.is_platform_admin()) with check (private.is_platform_admin());
revoke all on public.support_templates from anon, authenticated, public;
grant all on public.support_templates to service_role;
grant select, insert, delete on public.support_templates to authenticated;
grant update (title, text) on public.support_templates to authenticated;

insert into public.support_templates (title, text) values
  ('Продление доступа', 'Здравствуйте! Чтобы продлить доступ к Qabul, напишите, на какой срок, и мы пришлём реквизиты для оплаты. После оплаты доступ продлим в течение рабочего дня.'),
  ('Как подключить канал', 'Откройте раздел «Каналы», нажмите «Подключить» у нужной соцсети и следуйте шагам на экране. Если на каком-то шаге возникнет вопрос, пришлите скриншот сюда, и мы подскажем.');

-- ---------------------------------------------------------------------------
-- Вложения: приватное хранилище. В локальных тестах схемы storage нет, там это пропускается.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('support-attachments', 'support-attachments', false, 5242880)
    on conflict (id) do nothing;

    execute $p$create policy support_files_insert on storage.objects for insert to authenticated
      with check (
        bucket_id = 'support-attachments'
        and ((storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$')
        and (
          private.is_platform_admin()
          or private.is_owner_any_term(((storage.foldername(name))[1])::uuid)
        )
      )$p$;
    execute $p$create policy support_files_select on storage.objects for select to authenticated
      using (
        bucket_id = 'support-attachments'
        and ((storage.foldername(name))[1] ~ '^[0-9a-f-]{36}$')
        and (
          private.is_platform_admin()
          or private.is_owner_any_term(((storage.foldername(name))[1])::uuid)
        )
      )$p$;
  end if;
end;
$$;

revoke all on function
  public.support_set_status(uuid, text),
  public.support_send(uuid, text, boolean, text, text),
  public.platform_support_threads()
from anon, authenticated, public;
revoke all on function private.support_after_insert() from anon, authenticated, public;
grant execute on function
  public.support_set_status(uuid, text),
  public.support_send(uuid, text, boolean, text, text),
  public.platform_support_threads()
to authenticated, service_role;

-- Страховка: если мгновенный вызов не дошёл, непрочитанное уйдёт в Telegram в течение пяти минут.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron')
     and exists (select 1 from pg_available_extensions where name = 'pg_net') then
    perform cron.schedule('qabul-support-notify', '*/5 * * * *', $job$select private.call_edge_function('support-notify')$job$);
  end if;
end;
$$;
