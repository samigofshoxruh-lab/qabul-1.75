-- Чья заявка: владелец может всё, сотрудник не трогает заявки коллег.
-- Заявки удалённых из команды сотрудников освобождаются.

-- Кто держит заявку, если это другой действующий сотрудник, а вызывающий не владелец. Иначе null.
create function private.lead_holder_block(p_lead public.leads) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(m.email, 'другой сотрудник')
  from public.workspace_members m
  where p_lead.status = 'in_work'
    and p_lead.assigned_to is not null
    and p_lead.assigned_to <> auth.uid()
    and m.workspace_id = p_lead.workspace_id
    and m.user_id = p_lead.assigned_to
    and not private.is_owner(p_lead.workspace_id);
$$;

-- Взять заявку: владелец забирает любую, сотрудник только свободную или оставшуюся без хозяина.
create or replace function public.take_lead(p_lead_id uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_holder text;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_member(v_lead.workspace_id) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;

  v_holder := private.lead_holder_block(v_lead);
  if v_holder is not null then
    raise exception 'Заявку уже взял в работу %', v_holder using errcode = 'P0001';
  end if;

  begin
    update public.leads set
      status = 'in_work',
      taken_at = case when assigned_to is distinct from auth.uid() then now() else coalesce(taken_at, now()) end,
      assigned_to = auth.uid(),
      completed_at = coalesce(completed_at, now()),
      current_question_id = null,
      closed_at = null,
      unread_count = 0
    where id = p_lead_id;
  exception when unique_violation then
    raise exception 'У этого клиента уже есть открытая заявка' using errcode = 'P0001';
  end;
end;
$$;

-- Передать заявку сотруднику: может владелец или тот, у кого она сейчас.
create function public.assign_lead(p_lead_id uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
begin
  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_member(v_lead.workspace_id) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;
  if not (private.is_owner(v_lead.workspace_id) or v_lead.assigned_to = auth.uid()) then
    raise exception 'Передать заявку может владелец или сотрудник, у которого она сейчас' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workspace_members where workspace_id = v_lead.workspace_id and user_id = p_user) then
    raise exception 'Сотрудник не найден' using errcode = 'P0002';
  end if;
  if v_lead.status not in ('collecting', 'new', 'in_work') then
    raise exception 'Закрытую заявку сначала верните в работу' using errcode = 'P0001';
  end if;

  update public.leads set
    status = 'in_work',
    assigned_to = p_user,
    taken_at = now(),
    completed_at = coalesce(completed_at, now()),
    current_question_id = null,
    closed_at = null,
    unread_count = 0
  where id = p_lead_id;
end;
$$;

create or replace function public.set_lead_status(p_lead_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_lead public.leads;
  v_holder text;
begin
  if p_status not in ('new', 'in_work', 'done', 'rejected') then
    raise exception 'Неизвестный статус' using errcode = '22023';
  end if;

  select * into v_lead from public.leads where id = p_lead_id for update;
  if not found or not private.is_member(v_lead.workspace_id) then
    raise exception 'Заявка не найдена' using errcode = '42501';
  end if;

  v_holder := private.lead_holder_block(v_lead);
  if v_holder is not null then
    raise exception 'Заявка у сотрудника %. Менять её может он или владелец', v_holder using errcode = 'P0001';
  end if;

  begin
    update public.leads set
      status = p_status,
      current_question_id = null,
      completed_at = coalesce(completed_at, now()),
      assigned_to = case
        when p_status = 'new' then null
        when p_status = 'in_work' then coalesce(assigned_to, auth.uid())
        else assigned_to end,
      taken_at = case when p_status = 'new' then null else taken_at end,
      closed_at = case when p_status in ('done', 'rejected') then now() end,
      unread_count = case when p_status in ('done', 'rejected') then 0 else unread_count end
    where id = p_lead_id;
  exception when unique_violation then
    raise exception 'У этого клиента уже есть открытая заявка' using errcode = 'P0001';
  end;
end;
$$;


-- Назначить сразу несколько: владелец кому угодно, сотрудник только себе и только свободные заявки.
create or replace function public.bulk_assign(p_lead_ids uuid[], p_user uuid) returns integer
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
  if p_user <> auth.uid() and not private.is_owner(v_workspace) then
    raise exception 'Назначать заявки другим может только владелец' using errcode = '42501';
  end if;
  update public.leads l set
    assigned_to = p_user,
    status = 'in_work',
    taken_at = case when l.assigned_to is distinct from p_user then now() else coalesce(l.taken_at, now()) end,
    completed_at = coalesce(l.completed_at, now()),
    current_question_id = null
  where l.id = any (p_lead_ids)
    and l.workspace_id = v_workspace
    and l.status in ('new', 'in_work')
    and (
      private.is_owner(v_workspace)
      or l.assigned_to is null
      or l.assigned_to = auth.uid()
      or not exists (select 1 from public.workspace_members m where m.workspace_id = l.workspace_id and m.user_id = l.assigned_to)
    );
  get diagnostics v_done = row_count;
  return v_done;
end;
$$;

-- Сотрудника убрали из команды: его открытые заявки возвращаются в «Новые», чтобы их мог взять кто-то другой.
create function private.release_leads_of_member() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  update public.leads set assigned_to = null, taken_at = null, status = 'new'
  where workspace_id = old.workspace_id and assigned_to = old.user_id and status = 'in_work';
  return old;
end;
$$;
create trigger workspace_members_release_leads after delete on public.workspace_members
  for each row execute function private.release_leads_of_member();

-- Уже накопившиеся заявки удалённых сотрудников освобождаем сейчас.
update public.leads l set assigned_to = null, taken_at = null, status = 'new'
where l.status = 'in_work'
  and l.assigned_to is not null
  and not exists (select 1 from public.workspace_members m where m.workspace_id = l.workspace_id and m.user_id = l.assigned_to);

revoke all on function
  public.take_lead(uuid),
  public.assign_lead(uuid, uuid),
  public.set_lead_status(uuid, text),
  public.bulk_assign(uuid[], uuid)
from anon, authenticated, public;
revoke all on function private.lead_holder_block(public.leads), private.release_leads_of_member() from anon, authenticated, public;
grant execute on function
  public.take_lead(uuid),
  public.assign_lead(uuid, uuid),
  public.set_lead_status(uuid, text),
  public.bulk_assign(uuid[], uuid)
to authenticated, service_role;
