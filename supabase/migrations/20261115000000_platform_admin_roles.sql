-- Админы платформы: роли и права на каждую функцию. Права выдаёт главный админ.
-- Все, кто уже были админами, остаются главными и сохраняют все права.

alter table public.platform_admins
  add column email text,
  add column role text not null default 'main' check (role in ('main', 'manager', 'support', 'custom')),
  add column is_active boolean not null default true,
  add column can_manage_companies boolean not null default true,
  add column can_manage_access boolean not null default true,
  add column can_manage_users boolean not null default true,
  add column can_support boolean not null default true,
  add column can_manage_admins boolean not null default true,
  add column created_by uuid references auth.users (id) on delete set null;

update public.platform_admins p set email = u.email from auth.users u where u.id = p.user_id;

-- Поддержка доступна только админу с этим правом и только пока он включён.
create or replace function private.is_platform_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.platform_admins
    where user_id = auth.uid() and is_active and can_support
  );
$$;

-- Нельзя остаться без админа, который управляет админами.
create function private.platform_admins_guard() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.is_active and old.can_manage_admins
     and (tg_op = 'DELETE' or not (new.is_active and new.can_manage_admins))
     and not exists (
       select 1 from public.platform_admins
       where user_id <> old.user_id and is_active and can_manage_admins
     ) then
    raise exception 'Должен остаться хотя бы один активный админ с правом управлять админами' using errcode = 'P0001';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger platform_admins_guard before update or delete on public.platform_admins
  for each row execute function private.platform_admins_guard();

-- Кто, кому и что выдал.
create table public.platform_admin_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users (id) on delete set null,
  actor_email text,
  target_email text,
  action text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.platform_admin_log enable row level security;
revoke all on public.platform_admin_log from anon, authenticated, public;
grant all on public.platform_admin_log to service_role;

-- Сайт узнаёт свои права из этого ответа.
create or replace function public.my_access() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'is_platform_admin', exists (select 1 from public.platform_admins where user_id = auth.uid() and is_active),
    'platform', (
      select jsonb_build_object(
        'role', p.role,
        'can_manage_companies', p.can_manage_companies,
        'can_manage_access', p.can_manage_access,
        'can_manage_users', p.can_manage_users,
        'can_support', p.can_support,
        'can_manage_admins', p.can_manage_admins
      )
      from public.platform_admins p where p.user_id = auth.uid() and p.is_active
    ),
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

revoke all on function private.platform_admins_guard() from anon, authenticated, public;
revoke all on function public.my_access() from anon, authenticated, public;
grant execute on function public.my_access() to authenticated, service_role;
