-- История платежей, скидки, способы оплаты (наличные, карта, Payme, Click, перевод).
-- Payme и Click здесь только пометка для бухгалтерии компании: деньги проходят мимо Qabul.
-- lesson_students.paid остаётся итогом и всегда равен сумме платежей ученика.

-- ---------------------------------------------------------------------------
-- Скидка и долг с учётом скидки
-- ---------------------------------------------------------------------------

alter table public.lesson_students
  add column discount bigint not null default 0 check (discount between 0 and 1000000000000);

alter table public.lesson_students drop column debt;
alter table public.lesson_students
  add column debt bigint generated always as (greatest(price - discount - paid, 0)) stored;

grant update (name, phone, note, attended, price, discount, paid) on public.lesson_students to authenticated;

-- ---------------------------------------------------------------------------
-- Платежи
-- ---------------------------------------------------------------------------

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  student_id uuid not null references public.lesson_students (id) on delete cascade,
  -- Минус означает возврат или исправление.
  amount bigint not null check (amount <> 0 and amount between -1000000000000 and 1000000000000),
  method text not null default 'cash' check (method in ('cash', 'card', 'payme', 'click', 'transfer', 'other')),
  note text check (note is null or length(note) <= 500),
  paid_at timestamptz not null default now(),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index payments_student_idx on public.payments (student_id);
create index payments_workspace_date_idx on public.payments (workspace_id, paid_at desc);

alter table public.payments enable row level security;

create policy payments_select on public.payments for select to authenticated
  using (private.is_member(workspace_id));
create policy payments_insert on public.payments for insert to authenticated
  with check (
    private.is_member(workspace_id)
    and exists (select 1 from public.lesson_students s where s.id = student_id and s.workspace_id = payments.workspace_id)
  );
create policy payments_update on public.payments for update to authenticated
  using (private.is_member(workspace_id)) with check (private.is_member(workspace_id));
create policy payments_delete on public.payments for delete to authenticated
  using (private.is_member(workspace_id));

revoke all on public.payments from anon, authenticated, public;
grant all on public.payments to service_role;
grant select, insert, delete on public.payments to authenticated;
grant update (amount, method, note, paid_at) on public.payments to authenticated;

-- Платёж сам подставляет себя автором.
create function private.payment_defaults() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := coalesce(new.created_by, auth.uid());
  end if;
  return new;
end;
$$;

create trigger payments_defaults
  before insert on public.payments
  for each row execute function private.payment_defaults();

-- Любое изменение платежей пересчитывает «оплачено» у ученика.
create function private.payments_sync() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_student uuid;
begin
  v_student := case when tg_op = 'DELETE' then old.student_id else new.student_id end;
  perform set_config('qabul.payments_sync', '1', true);
  update public.lesson_students s
  set paid = greatest((select coalesce(sum(amount), 0) from public.payments where student_id = s.id), 0)
  where s.id = v_student;
  perform set_config('qabul.payments_sync', '', true);
  return null;
end;
$$;

create trigger payments_sync_aiud
  after insert or update or delete on public.payments
  for each row execute function private.payments_sync();

-- Если «оплачено» поправили вручную (в уроке), разницу записываем платежом, чтобы история сходилась.
create function private.lesson_student_paid_changed() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(current_setting('qabul.payments_sync', true), '') = '1' then
    return new;
  end if;
  if new.paid is distinct from old.paid then
    insert into public.payments (workspace_id, student_id, amount, method, note, created_by)
    values (new.workspace_id, new.id, new.paid - old.paid, 'other', 'Исправлено вручную в уроке', auth.uid());
  end if;
  return new;
end;
$$;

-- AFTER, чтобы строка ученика уже была обновлена, а пересчёт не менял итог повторно.
create trigger lesson_students_paid_changed
  after update of paid on public.lesson_students
  for each row when (old.paid is distinct from new.paid)
  execute function private.lesson_student_paid_changed();

-- Старые данные: то, что уже записано в «оплачено», становится одним платежом.
do $$
begin
  perform set_config('qabul.payments_sync', '1', true);
  insert into public.payments (workspace_id, student_id, amount, method, note, paid_at)
  select workspace_id, id, paid, 'other', 'Перенесено из прежних данных', created_at
  from public.lesson_students
  where paid > 0;
  perform set_config('qabul.payments_sync', '', true);
end;
$$;

revoke all on function
  private.payment_defaults(),
  private.payments_sync(),
  private.lesson_student_paid_changed()
from anon, authenticated, public;
