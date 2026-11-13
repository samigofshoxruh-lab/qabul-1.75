-- Анкета бота: ветвление, проверка ответов, два языка, рабочее время, статистика.

alter table public.surveys
  add column multilingual boolean not null default false,
  add column welcome_text_uz text,
  add column completion_text_uz text;

alter table public.questions
  add column text_uz text check (length(text_uz) <= 900),
  -- {"question_id": "...", "option_ids": ["a", "b"]}: вопрос показывается, только если на указанный выбрали один из вариантов.
  add column show_if jsonb,
  add column validation text not null default 'none' check (validation in ('none', 'number', 'age', 'phone_uz', 'email')),
  add column is_language boolean not null default false;

alter table public.contacts add column lang text check (lang in ('ru', 'uz'));

-- {"from": "09:00", "to": "18:00", "days": [1,2,3,4,5,6], "text": "...", "text_uz": "..."}; пусто значит «всегда на связи».
alter table public.workspaces add column work_hours jsonb;
alter table public.leads add column off_hours_notified_at timestamptz;

create function private.pick_lang(p_ru text, p_uz text, p_lang text) returns text
language sql immutable as $$
  select case when p_lang = 'uz' and nullif(btrim(coalesce(p_uz, '')), '') is not null then p_uz else p_ru end;
$$;

-- Вопрос на языке клиента.
drop function private.question_payload(public.questions);
create function private.question_payload(q public.questions, p_contact uuid default null) returns jsonb
language plpgsql stable as $$
declare
  v_lang text;
  v_options jsonb := case when q.type = 'choice' then q.options else '[]'::jsonb end;
  v_text text;
begin
  if p_contact is not null then
    select lang into v_lang from public.contacts where id = p_contact;
  end if;
  v_text := private.pick_lang(q.text, q.text_uz, v_lang);
  if v_lang = 'uz' then
    select coalesce(jsonb_agg(
      case when nullif(btrim(coalesce(o ->> 'label_uz', '')), '') is not null
        then jsonb_set(o, '{label}', to_jsonb(o ->> 'label_uz')) else o end
      order by ord), '[]'::jsonb)
    into v_options
    from jsonb_array_elements(v_options) with ordinality as t(o, ord);
  end if;
  if not q.required then
    v_options := v_options || jsonb_build_array(jsonb_build_object(
      'id', 'skip', 'label', case when v_lang = 'uz' then 'O''tkazib yuborish' else 'Пропустить' end));
  end if;
  if q.type = 'choice' and q.allow_other then
    v_text := v_text || E'\n\n' || case when v_lang = 'uz'
      then 'Variantni tanlang yoki o''zingiznikini yozing.' else 'Выберите вариант или напишите свой.' end;
  end if;
  return jsonb_build_object('text', v_text, 'options', v_options);
end;
$$;

-- Следующий вопрос: первый по порядку без ответа, у которого выполнено условие показа.
create or replace function private.next_question(p_lead uuid, p_survey uuid) returns public.questions
language sql stable as $$
  select q.* from public.questions q
  where q.survey_id = p_survey
    and not exists (select 1 from public.answers a where a.lead_id = p_lead and a.question_id = q.id)
    and (
      q.show_if is null
      or exists (
        select 1 from public.answers a
        where a.lead_id = p_lead
          and a.question_id = nullif(q.show_if ->> 'question_id', '')::uuid
          and a.option_id in (select jsonb_array_elements_text(q.show_if -> 'option_ids'))
      )
    )
  order by q.position, q.created_at, q.id
  limit 1;
$$;

-- ---------------------------------------------------------------------------
-- Ядро бота с проверкой ответов и языками
-- ---------------------------------------------------------------------------

create or replace function private.bot_handle_inbound_core(
  p_channel_id uuid,
  p_external_user_id text,
  p_external_message_id text,
  p_text text default null,
  p_option_id text default null,
  p_display_name text default null,
  p_username text default null,
  p_contact_meta jsonb default '{}'::jsonb,
  p_attachment text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  c_handoff_words constant text[] := array['оператор', 'менеджер', 'человек', 'админ', 'администратор', 'operator', 'manager', 'menejer', 'admin'];
  c_handoff_text constant text := 'Передаю ваш вопрос администратору. Он ответит вам здесь.';
  v_channel public.channels;
  v_survey public.surveys;
  v_lead public.leads;
  v_last public.leads;
  v_q public.questions;
  v_next public.questions;
  v_contact_id uuid;
  v_new_contact boolean := false;
  v_text text := nullif(btrim(coalesce(p_text, '')), '');
  v_payload jsonb;
  v_options jsonb;
  v_option jsonb;
  v_answer text;
  v_option_id text;
  v_hint text;
  v_digits text;
  v_stored_text text;
  v_outbound jsonb := '[]'::jsonb;
  v_attempts integer;
  v_number integer;
  v_lang text;
  v_welcome text;
begin
  select * into v_channel from public.channels where id = p_channel_id and deleted_at is null;
  if not found or not v_channel.is_active then
    return jsonb_build_object('ignored', true);
  end if;

  update public.channels set
    last_event_at = now(),
    status = 'active',
    last_error = null,
    last_error_at = null
  where id = v_channel.id;

  -- Блокировка строки контакта выстраивает его сообщения в очередь до конца транзакции.
  select id into v_contact_id from public.contacts
  where channel_id = v_channel.id and external_id = p_external_user_id;
  v_new_contact := v_contact_id is null;

  insert into public.contacts (workspace_id, channel_id, external_id, display_name, username, meta)
  values (v_channel.workspace_id, v_channel.id, p_external_user_id, p_display_name, p_username, coalesce(p_contact_meta, '{}'::jsonb))
  on conflict (channel_id, external_id) do update set
    display_name = coalesce(excluded.display_name, public.contacts.display_name),
    username = coalesce(excluded.username, public.contacts.username),
    meta = public.contacts.meta || excluded.meta,
    last_seen_at = now()
  returning id into v_contact_id;
  select lang into v_lang from public.contacts where id = v_contact_id;

  if p_external_message_id is not null and exists (
    select 1 from public.messages where channel_id = v_channel.id and external_id = p_external_message_id
  ) then
    return jsonb_build_object('duplicate', true);
  end if;

  select * into v_lead from public.leads
  where contact_id = v_contact_id and status in ('collecting', 'new', 'in_work')
  limit 1;

  -- Открытой заявки нет: возобновляем недавно закрытую или начинаем новую.
  if not found then
    select * into v_survey from public.surveys
    where workspace_id = v_channel.workspace_id
      and (id = v_channel.survey_id or (v_channel.survey_id is null and is_default))
    limit 1;

    select * into v_last from public.leads
    where contact_id = v_contact_id
    order by created_at desc limit 1;

    if v_last.id is not null and v_last.closed_at is not null
       and v_last.closed_at > now() - make_interval(hours => coalesce(v_survey.restart_after_hours, 24)) then
      update public.leads set
        status = case when assigned_to is null then 'new' else 'in_work' end,
        closed_at = null
      where id = v_last.id;

      insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
      values (v_channel.workspace_id, v_last.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);

      return jsonb_build_object('lead_id', v_last.id, 'outbound', '[]'::jsonb, 'new_contact', v_new_contact);
    end if;

    if v_survey.id is not null then
      select * into v_q from public.questions
      where survey_id = v_survey.id
      order by position, created_at, id limit 1;
    end if;

    insert into public.leads (workspace_id, channel_id, contact_id, survey_id, status, current_question_id, completed_at)
    values (
      v_channel.workspace_id, v_channel.id, v_contact_id, v_survey.id,
      case when v_q.id is null then 'new' else 'collecting' end,
      v_q.id,
      case when v_q.id is null then now() end
    )
    returning * into v_lead;

    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);

    if v_q.id is not null then
      v_welcome := private.pick_lang(v_survey.welcome_text, v_survey.welcome_text_uz, v_lang);
      if not v_survey.multilingual and nullif(btrim(coalesce(v_welcome, '')), '') is not null then
        v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, v_welcome);
      end if;
      v_payload := private.question_payload(v_q, v_contact_id);
      v_outbound := v_outbound || private.queue_out(
        v_lead.id, v_channel.workspace_id, v_channel.id, v_payload ->> 'text', v_payload -> 'options'
      );
    end if;

    return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
  end if;

  -- Заявка уже у людей: бот молчит, сообщение просто попадает к администратору.
  if v_lead.status <> 'collecting' then
    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);
    return jsonb_build_object('lead_id', v_lead.id, 'outbound', '[]'::jsonb, 'new_contact', v_new_contact);
  end if;

  select * into v_q from public.questions where id = v_lead.current_question_id;
  if not found then
    v_q := private.next_question(v_lead.id, v_lead.survey_id);
  end if;

  v_stored_text := coalesce(v_text, case when p_option_id is not null then 'Нажата устаревшая кнопка' end);

  -- Клиент просит живого человека.
  if lower(coalesce(v_text, '')) = any (c_handoff_words) then
    update public.leads set
      status = 'new', handoff = true, current_question_id = null, completed_at = now()
    where id = v_lead.id;
    insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
    values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_text, p_attachment, p_external_message_id);
    v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, c_handoff_text);
    return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
  end if;

  if v_q.id is not null then
    v_payload := private.question_payload(v_q, v_contact_id);
    v_options := v_payload -> 'options';

    if lower(coalesce(v_text, '')) like '/start%' then
      v_hint := '';
    elsif v_text is null and p_option_id is null then
      v_hint := 'Пока я понимаю только текст.';
    else
      -- Кнопка или текст совпали с вариантом ответа?
      if p_option_id is not null then
        select o into v_option from jsonb_array_elements(v_options) o where o ->> 'id' = p_option_id limit 1;
      end if;
      if v_option is null and v_text is not null then
        select o into v_option from jsonb_array_elements(v_options) o
        where lower(btrim(o ->> 'label')) = lower(v_text) limit 1;
      end if;
      -- Номер варианта считается только в вопросах с выбором: в текстовом «1» это ответ.
      if v_option is null and v_q.type = 'choice' and v_text ~ '^[0-9]{1,2}[.)]?$' then
        v_number := (regexp_match(v_text, '^([0-9]{1,2})'))[1]::integer;
        if v_number between 1 and jsonb_array_length(v_options) then
          v_option := v_options -> (v_number - 1);
        end if;
      end if;

      if v_option is not null then
        v_option_id := v_option ->> 'id';
        v_stored_text := v_option ->> 'label';
        v_answer := case when v_option_id = 'skip' then null else v_option ->> 'label' end;
      elsif v_q.type = 'choice' then
        if v_q.allow_other and v_text is not null then
          v_answer := left(v_text, 2000);
        else
          v_hint := 'Выберите один из вариантов.';
        end if;
      elsif v_q.type = 'phone' then
        v_digits := regexp_replace(coalesce(v_text, ''), '[^0-9]', '', 'g');
        if v_q.validation = 'phone_uz' then
          if length(v_digits) = 9 then
            v_digits := '998' || v_digits;
          end if;
          if v_text ~ '^[+0-9 ()\-.]+$' and v_digits ~ '^998[0-9]{9}$' then
            v_answer := '+' || v_digits;
            update public.contacts set phone = v_answer where id = v_contact_id;
          else
            v_hint := case when v_lang = 'uz' then 'Raqam +998 90 123 45 67 formatida bo''lishi kerak.'
              else 'Номер должен быть в формате +998 90 123 45 67.' end;
          end if;
        elsif v_text ~ '^[+0-9 ()\-.]+$' and length(v_digits) between 7 and 15 then
          v_answer := case when v_text like '+%' then '+' else '' end || v_digits;
          update public.contacts set phone = v_answer where id = v_contact_id;
        else
          v_hint := 'Похоже, в номере ошибка. Напишите его цифрами, например +998 90 123 45 67.';
        end if;
      else
        if v_text is null then
          v_hint := 'Напишите ответ текстом.';
        elsif v_q.validation = 'number' and v_text !~ '^[0-9]{1,15}$' then
          v_hint := case when v_lang = 'uz' then 'Raqamni faqat sonlar bilan yozing.' else 'Напишите число цифрами.' end;
        elsif v_q.validation = 'age' and not (v_text ~ '^[0-9]{1,3}$' and v_text::integer between 1 and 120) then
          v_hint := case when v_lang = 'uz' then 'Yoshni son bilan yozing, masalan 25.' else 'Напишите возраст числом, например 25.' end;
        elsif v_q.validation = 'email' and v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
          v_hint := case when v_lang = 'uz' then 'Elektron pochtani to''g''ri yozing.' else 'Похоже, в адресе почты ошибка.' end;
        elsif v_q.validation = 'phone_uz' then
          v_digits := regexp_replace(v_text, '[^0-9]', '', 'g');
          if length(v_digits) = 9 then
            v_digits := '998' || v_digits;
          end if;
          if v_text ~ '^[+0-9 ()\-.]+$' and v_digits ~ '^998[0-9]{9}$' then
            v_answer := '+' || v_digits;
            update public.contacts set phone = v_answer where id = v_contact_id;
          else
            v_hint := case when v_lang = 'uz' then 'Raqam +998 90 123 45 67 formatida bo''lishi kerak.'
              else 'Номер должен быть в формате +998 90 123 45 67.' end;
          end if;
        else
          v_answer := left(v_text, 2000);
        end if;
      end if;
    end if;

    if v_hint is not null then
      -- /start просто повторяет вопрос и не считается ошибкой. После трёх ошибок зовём человека.
      insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
      values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_stored_text, p_attachment, p_external_message_id);

      v_attempts := v_lead.invalid_attempts + case when v_hint = '' then 0 else 1 end;
      if v_attempts >= 3 then
        update public.leads set
          status = 'new', handoff = true, current_question_id = null, completed_at = now(), invalid_attempts = v_attempts
        where id = v_lead.id;
        v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, c_handoff_text);
      else
        update public.leads set invalid_attempts = v_attempts, current_question_id = v_q.id where id = v_lead.id;
        v_outbound := v_outbound || private.queue_out(
          v_lead.id, v_channel.workspace_id, v_channel.id,
          case when v_hint = '' then v_payload ->> 'text' else v_hint || E'\n\n' || (v_payload ->> 'text') end,
          v_options
        );
      end if;
      return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
    end if;

    insert into public.answers (workspace_id, lead_id, question_id, question_text, position, answer_text, option_id)
    values (v_channel.workspace_id, v_lead.id, v_q.id, v_q.text, v_q.position, v_answer, v_option_id)
    on conflict (lead_id, question_id) do update set
      answer_text = excluded.answer_text, option_id = excluded.option_id;

    if v_q.is_language and v_option_id in ('ru', 'uz') then
      update public.contacts set lang = v_option_id where id = v_contact_id;
      v_lang := v_option_id;
      select * into v_survey from public.surveys where id = v_lead.survey_id;
      v_welcome := private.pick_lang(v_survey.welcome_text, v_survey.welcome_text_uz, v_lang);
      if nullif(btrim(coalesce(v_welcome, '')), '') is not null then
        v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, v_welcome);
      end if;
    end if;
  end if;

  insert into public.messages (workspace_id, lead_id, channel_id, direction, sender, text, attachment, external_id)
  values (v_channel.workspace_id, v_lead.id, v_channel.id, 'in', 'contact', v_stored_text, p_attachment, p_external_message_id);

  v_next := private.next_question(v_lead.id, v_lead.survey_id);

  if v_next.id is not null then
    update public.leads set current_question_id = v_next.id, invalid_attempts = 0 where id = v_lead.id;
    v_payload := private.question_payload(v_next, v_contact_id);
    v_outbound := v_outbound || private.queue_out(
      v_lead.id, v_channel.workspace_id, v_channel.id, v_payload ->> 'text', v_payload -> 'options'
    );
  else
    update public.leads set
      status = 'new', current_question_id = null, completed_at = now(), invalid_attempts = 0
    where id = v_lead.id;
    select * into v_survey from public.surveys where id = v_lead.survey_id;
    v_welcome := private.pick_lang(v_survey.completion_text, v_survey.completion_text_uz, v_lang);
    if nullif(btrim(coalesce(v_welcome, '')), '') is not null then
      v_outbound := v_outbound || private.queue_out(v_lead.id, v_channel.workspace_id, v_channel.id, v_welcome);
    end if;
  end if;

  return jsonb_build_object('lead_id', v_lead.id, 'outbound', v_outbound, 'new_contact', v_new_contact);
end;
$$;


-- Рабочее время: вне его после анкеты бот пишет «ответим утром», не чаще раза в 8 часов.
create function private.in_work_hours(p_hours jsonb, p_at timestamptz) returns boolean
language plpgsql stable as $$
declare
  v_local timestamp := p_at at time zone 'Asia/Tashkent';
begin
  if p_hours is null then
    return true;
  end if;
  return coalesce((p_hours -> 'days') @> to_jsonb(extract(isodow from v_local)::integer), true)
    and v_local::time >= (p_hours ->> 'from')::time
    and v_local::time < (p_hours ->> 'to')::time;
end;
$$;

create or replace function public.bot_handle_inbound(
  p_channel_id uuid,
  p_external_user_id text,
  p_external_message_id text,
  p_text text default null,
  p_option_id text default null,
  p_display_name text default null,
  p_username text default null,
  p_contact_meta jsonb default '{}'::jsonb,
  p_attachment text default null
) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_res jsonb;
  v_lead public.leads;
  v_hours jsonb;
  v_lang text;
  v_msg text;
  v_payload text;
begin
  if not exists (
    select 1
    from public.channels c
    join public.workspaces w on w.id = c.workspace_id
    where c.id = p_channel_id
      and not w.is_suspended
      and (w.access_until is null or w.access_until > now())
  ) then
    return jsonb_build_object('ignored', true);
  end if;

  update public.leads l set
    status = case when l.assigned_to is null then 'new' else 'in_work' end,
    closed_at = null
  where l.id = (
      select x.id
      from public.contacts c
      join public.leads x on x.contact_id = c.id
      where c.channel_id = p_channel_id and c.external_id = p_external_user_id
      order by x.created_at desc
      limit 1
    )
    and l.status in ('done', 'rejected')
    and exists (select 1 from public.channels ch where ch.id = p_channel_id and ch.is_active and ch.deleted_at is null)
    and exists (
      select 1
      from public.lesson_reminders r
      join public.lesson_students s on s.id = r.student_id
      join public.messages m on m.id = r.message_id
      where s.contact_id = l.contact_id
        and m.status = 'sent'
        and r.created_at > now() - interval '48 hours'
    );

  v_res := private.bot_handle_inbound_core(
    p_channel_id, p_external_user_id, p_external_message_id, p_text, p_option_id,
    p_display_name, p_username, p_contact_meta, p_attachment
  );

  if v_res ? 'lead_id' then
    select * into v_lead from public.leads where id = (v_res ->> 'lead_id')::uuid;

    -- Ссылка бота с меткой (t.me/бот?start=instagram_ads) задаёт источник новой заявки.
    v_payload := (regexp_match(coalesce(p_text, ''), '^/start\s+([A-Za-z0-9_\-]{1,60})'))[1];
    if v_payload is not null and v_lead.created_at > now() - interval '2 minutes' then
      update public.leads set source = v_payload where id = v_lead.id;
    end if;

    select w.work_hours into v_hours from public.workspaces w where w.id = v_lead.workspace_id;
    if v_hours is not null
       and v_lead.status = 'new'
       and (v_lead.off_hours_notified_at is null or v_lead.off_hours_notified_at < now() - interval '8 hours')
       and not private.in_work_hours(v_hours, now()) then
      select lang into v_lang from public.contacts where id = v_lead.contact_id;
      v_msg := private.pick_lang(v_hours ->> 'text', v_hours ->> 'text_uz', v_lang);
      if nullif(btrim(coalesce(v_msg, '')), '') is not null then
        v_res := jsonb_set(
          v_res, '{outbound}',
          coalesce(v_res -> 'outbound', '[]'::jsonb)
            || private.queue_out(v_lead.id, v_lead.workspace_id, v_lead.channel_id, v_msg)
        );
        update public.leads set off_hours_notified_at = now() where id = v_lead.id;
      end if;
    end if;
  end if;

  return v_res;
end;
$$;

-- ---------------------------------------------------------------------------
-- Рабочее время и статистика анкеты
-- ---------------------------------------------------------------------------

create function public.set_work_hours(p_workspace uuid, p_hours jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if not private.can_edit_survey(p_workspace) then
    raise exception 'Нет доступа' using errcode = '42501';
  end if;
  if p_hours is not null then
    if jsonb_typeof(p_hours) <> 'object'
       or (p_hours ->> 'from') !~ '^[0-2][0-9]:[0-5][0-9]$'
       or (p_hours ->> 'to') !~ '^[0-2][0-9]:[0-5][0-9]$'
       or (p_hours ->> 'from')::time >= (p_hours ->> 'to')::time
       or jsonb_typeof(p_hours -> 'days') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_hours -> 'days') d where d::text !~ '^[1-7]$')
       or length(coalesce(p_hours ->> 'text', '')) > 500
       or length(coalesce(p_hours ->> 'text_uz', '')) > 500 then
      raise exception 'Проверьте рабочее время' using errcode = '22023';
    end if;
    p_hours := jsonb_build_object(
      'from', p_hours ->> 'from', 'to', p_hours ->> 'to', 'days', p_hours -> 'days',
      'text', coalesce(p_hours ->> 'text', ''), 'text_uz', coalesce(p_hours ->> 'text_uz', ''));
  end if;
  update public.workspaces set work_hours = p_hours where id = p_workspace;
end;
$$;

-- Где клиенты бросают анкету: по каждому вопросу сколько ответили и сколько застряли на нём больше 6 часов.
create function public.survey_stats(p_survey uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  v_workspace uuid;
begin
  select workspace_id into v_workspace from public.surveys where id = p_survey;
  if v_workspace is null or not private.is_member(v_workspace) then
    raise exception 'Опрос не найден' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'started', (select count(*) from public.leads where survey_id = p_survey),
    'completed', (select count(*) from public.leads where survey_id = p_survey and status <> 'collecting'),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', q.id,
        'answered', (select count(*) from public.answers a where a.question_id = q.id),
        'stuck', (
          select count(*) from public.leads l
          where l.current_question_id = q.id and l.status = 'collecting'
            and l.last_message_at < now() - interval '6 hours'
        )
      ) order by q.position, q.created_at)
      from public.questions q where q.survey_id = p_survey
    ), '[]'::jsonb)
  );
end;
$$;

revoke all on function
  public.set_work_hours(uuid, jsonb),
  public.survey_stats(uuid),
  public.bot_handle_inbound(uuid, text, text, text, text, text, text, jsonb, text)
from anon, authenticated, public;
revoke all on function
  private.pick_lang(text, text, text),
  private.in_work_hours(jsonb, timestamptz),
  private.question_payload(public.questions, uuid),
  private.bot_handle_inbound_core(uuid, text, text, text, text, text, text, jsonb, text)
from anon, authenticated, public;

grant execute on function public.set_work_hours(uuid, jsonb), public.survey_stats(uuid) to authenticated, service_role;
grant execute on function public.bot_handle_inbound(uuid, text, text, text, text, text, text, jsonb, text) to service_role;
