import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, BarChart3, Bell, BellOff, CheckSquare, Download, Search, Send, X } from "lucide-react";
import { useApp } from "../App";
import { QuickReplies } from "../components/QuickReplies";
import { Modal } from "../components/ui";
import { useSoundSetting } from "../lib/newLeadAlert";
import { ChannelTag, Empty, ErrorNote } from "../components/ui";
import { contactName, csvCell, fullTime, money, shortTime, STATUS_LABEL } from "../lib/format";
import { PLATFORMS } from "../lib/platforms";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Answer, Lead, LeadStatus, Lesson, LessonStudent, Member, Message, Question } from "../lib/types";

const LEAD_COLUMNS = "*, contacts(display_name, username, phone, external_id), channels(platform, name)";
const POLL_MS = 15_000;

type Tab = "new" | "in_work" | "mine" | "collecting" | "closed";

const TABS: { id: Tab; label: string; statuses: LeadStatus[] }[] = [
  { id: "new", label: "Новые", statuses: ["new"] },
  { id: "in_work", label: "В работе", statuses: ["in_work"] },
  { id: "mine", label: "Мои заявки", statuses: [] },
  { id: "collecting", label: "В опросе", statuses: ["collecting"] },
  { id: "closed", label: "Закрытые", statuses: ["done", "rejected"] },
];

const tabOf = (status: LeadStatus): Tab => TABS.find((t) => t.statuses.includes(status))!.id;
const isOverdue = (lead: Lead) =>
  Boolean(lead.follow_up_at && new Date(lead.follow_up_at).getTime() < Date.now() && (lead.status === "new" || lead.status === "in_work"));

export function LeadsPage() {
  const { workspace, userId } = useApp();
  const { leadId } = useParams();
  const navigate = useNavigate();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [tab, setTab] = useState<Tab>("new");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [hasChannels, setHasChannels] = useState(true);
  const [channelFilter, setChannelFilter] = useState("all");
  const [assigneeFilter, setAssigneeFilter] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [onlyOverdue, setOnlyOverdue] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [assignTo, setAssignTo] = useState("");
  const [members, setMembers] = useState<Member[]>([]);
  const [showStats, setShowStats] = useState(false);
  const [sound, setSound] = useSoundSetting();
  const [notice, setNotice] = useState("");

  useEffect(() => {
    supabase.from("workspace_members").select("user_id, email, role, created_at").eq("workspace_id", workspace.id)
      .then(({ data }) => setMembers((data ?? []) as Member[]));
  }, [workspace.id]);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase
      .from("leads")
      .select(LEAD_COLUMNS)
      .eq("workspace_id", workspace.id)
      .order("last_message_at", { ascending: false })
      .limit(500);
    if (e) {
      setError(`Не удалось загрузить заявки: ${e.message}`);
      return;
    }
    setError("");
    setLeads(data as unknown as Lead[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
    supabase
      .from("channels")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspace.id)
      .is("deleted_at", null)
      .then(({ count }) => setHasChannels(Boolean(count)));

    // Realtime доставляет изменения сразу, опрос раз в 15 секунд страхует от обрыва соединения.
    const live = supabase
      .channel(`leads-${workspace.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "leads", filter: `workspace_id=eq.${workspace.id}` }, () => load())
      .subscribe();
    const timer = setInterval(load, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [load, workspace.id]);

  const counts = useMemo(() => {
    const result: Record<Tab, number> = { new: 0, in_work: 0, mine: 0, collecting: 0, closed: 0 };
    for (const lead of leads ?? []) {
      result[tabOf(lead.status)]++;
      if (lead.assigned_to === userId && lead.status === "in_work") result.mine++;
    }
    return result;
  }, [leads, userId]);

  const overdueCount = useMemo(() => (leads ?? []).filter(isOverdue).length, [leads]);
  const channelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const lead of leads ?? []) if (lead.channels) map.set(lead.channel_id, lead.channels.name);
    return [...map.entries()];
  }, [leads]);

  useEffect(() => {
    document.title = counts.new > 0 ? `(${counts.new}) Qabul` : "Qabul";
    return () => {
      document.title = "Qabul";
    };
  }, [counts.new]);

  const selected = leads?.find((l) => l.id === leadId) ?? null;

  // Вкладка следует за заявкой, открытой по прямой ссылке.
  const followed = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (selected && followed.current !== selected.id) {
      followed.current = selected.id;
      setTab(tabOf(selected.status));
    }
  }, [selected]);

  const visible = useMemo(() => {
    const statuses = TABS.find((t) => t.id === tab)!.statuses;
    const q = query.trim().toLowerCase();
    const from = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : null;
    const to = dateTo ? new Date(`${dateTo}T23:59:59`).getTime() : null;
    const list = (leads ?? []).filter((lead) => {
      if (channelFilter !== "all" && lead.channel_id !== channelFilter) return false;
      if (assigneeFilter === "me" && lead.assigned_to !== userId) return false;
      if (assigneeFilter === "none" && lead.assigned_to) return false;
      if (assigneeFilter !== "all" && assigneeFilter !== "me" && assigneeFilter !== "none" && lead.assigned_to !== assigneeFilter) return false;
      const created = new Date(lead.created_at).getTime();
      if (from !== null && created < from) return false;
      if (to !== null && created > to) return false;
      if (onlyOverdue && !isOverdue(lead)) return false;
      if (!q) {
        if (tab === "mine") return lead.assigned_to === userId && lead.status === "in_work";
        return statuses.includes(lead.status);
      }
      return [lead.contacts?.display_name, lead.contacts?.username, lead.contacts?.phone, lead.last_message_preview, lead.source, ...(lead.tags ?? [])]
        .some((v) => v?.toLowerCase().includes(q));
    });
    // Просроченные «вернуться к клиенту» всплывают наверх.
    return [...list].sort((a, b) => Number(isOverdue(b)) - Number(isOverdue(a)));
  }, [leads, tab, query, channelFilter, assigneeFilter, dateFrom, dateTo, onlyOverdue, userId]);

  const filtersOn = channelFilter !== "all" || assigneeFilter !== "all" || Boolean(dateFrom) || Boolean(dateTo) || onlyOverdue;

  function togglePick(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function stopSelecting() {
    setSelecting(false);
    setPicked(new Set());
    setAssignTo("");
  }

  async function bulk(kind: "done" | "rejected" | "assign") {
    if (picked.size === 0) return;
    setError("");
    setNotice("");
    const ids = [...picked];
    const { data, error: e } =
      kind === "assign"
        ? await supabase.rpc("bulk_assign", { p_lead_ids: ids, p_user: assignTo || userId })
        : await supabase.rpc("bulk_set_status", { p_lead_ids: ids, p_status: kind });
    if (e) {
      setError(e.message);
      return;
    }
    const done = Number(data);
    setNotice(done === ids.length ? `Готово: ${done}.` : `Обработано ${done} из ${ids.length}. Остальные нельзя изменить: у клиента уже есть другая открытая заявка или заявка ещё в опросе.`);
    stopSelecting();
    await load();
  }

  async function exportCsv() {
    const ids = visible.map((l) => l.id);
    const { data, error: e } = await supabase.from("answers").select("lead_id, question_text, answer_text, position").in("lead_id", ids).order("position");
    if (e) {
      setError(`Не удалось выгрузить ответы: ${e.message}`);
      return;
    }
    const questions = [...new Set((data ?? []).map((a) => a.question_text))];
    const head = ["Дата", "Статус", "Канал", "Клиент", "Телефон", ...questions];
    const rows = visible.map((lead) => {
      const own = (data ?? []).filter((a) => a.lead_id === lead.id);
      return [
        fullTime(lead.created_at),
        STATUS_LABEL[lead.status],
        lead.channels ? PLATFORMS[lead.channels.platform].label : "",
        contactName(lead),
        lead.contacts?.phone,
        ...questions.map((q) => own.find((a) => a.question_text === q)?.answer_text),
      ];
    });
    const csv = [head, ...rows].map((row) => row.map(csvCell).join(";")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `zayavki-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className={`leads ${leadId ? "has-detail" : ""}`}>
      <section className="lead-list" aria-label="Заявки">
        <header className="lead-list-head">
          <div className="lead-list-title">
            <h1>Заявки</h1>
            <button type="button" className="icon-button" onClick={() => setSound(!sound)} title={sound ? "Звук о новых заявках включён" : "Звук о новых заявках выключен"} aria-label={sound ? "Выключить звук о новых заявках" : "Включить звук о новых заявках"} aria-pressed={sound}>
              {sound ? <Bell size={18} aria-hidden /> : <BellOff size={18} aria-hidden />}
            </button>
            <button type="button" className="icon-button" onClick={() => setShowStats(true)} title="Какой источник приносит больше" aria-label="Статистика по источникам">
              <BarChart3 size={18} aria-hidden />
            </button>
            <button type="button" className={`icon-button ${selecting ? "is-on" : ""}`} onClick={() => (selecting ? stopSelecting() : setSelecting(true))} title="Выбрать несколько заявок" aria-label="Выбрать несколько заявок" aria-pressed={selecting}>
              <CheckSquare size={18} aria-hidden />
            </button>
            <button type="button" className="icon-button" onClick={exportCsv} disabled={visible.length === 0} title="Скачать CSV" aria-label="Скачать CSV">
              <Download size={18} aria-hidden />
            </button>
          </div>
          <label className="search">
            <Search size={16} aria-hidden />
            <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя, телефон или текст" aria-label="Поиск по заявкам" />
          </label>
          <div className="lead-filters">
            <select value={channelFilter} onChange={(e) => setChannelFilter(e.target.value)} aria-label="Канал">
              <option value="all">Все каналы</option>
              {channelOptions.map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
            <select value={assigneeFilter} onChange={(e) => setAssigneeFilter(e.target.value)} aria-label="Ответственный">
              <option value="all">Все ответственные</option>
              <option value="me">Я</option>
              <option value="none">Не назначены</option>
              {members.filter((m) => m.user_id !== userId).map((m) => (
                <option key={m.user_id} value={m.user_id}>{m.email}</option>
              ))}
            </select>
            <label className="lead-date">С <input type="date" value={dateFrom} max={dateTo || undefined} onChange={(e) => setDateFrom(e.target.value)} /></label>
            <label className="lead-date">По <input type="date" value={dateTo} min={dateFrom || undefined} onChange={(e) => setDateTo(e.target.value)} /></label>
            {overdueCount > 0 && (
              <button type="button" className={`chip chip-bad ${onlyOverdue ? "is-on" : ""}`} onClick={() => setOnlyOverdue(!onlyOverdue)} aria-pressed={onlyOverdue}>
                Просрочено: {overdueCount}
              </button>
            )}
            {filtersOn && (
              <button type="button" className="link-button" onClick={() => { setChannelFilter("all"); setAssigneeFilter("all"); setDateFrom(""); setDateTo(""); setOnlyOverdue(false); }}>
                Сбросить
              </button>
            )}
          </div>
          {selecting && (
            <div className="bulk-bar" role="group" aria-label="Действия с выбранными заявками">
              <span>Выбрано: {picked.size}</span>
              <button type="button" className="button" onClick={() => bulk("done")} disabled={picked.size === 0}>Завершить</button>
              <button type="button" className="button" onClick={() => bulk("rejected")} disabled={picked.size === 0}>Отказ</button>
              <select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} aria-label="Кому назначить">
                <option value="">Мне</option>
                {members.filter((m) => m.user_id !== userId).map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.email}</option>
                ))}
              </select>
              <button type="button" className="button" onClick={() => bulk("assign")} disabled={picked.size === 0}>Назначить</button>
              <button type="button" className="link-button" onClick={() => setPicked(new Set(visible.map((l) => l.id)))}>Выбрать все</button>
            </div>
          )}
          {!query && (
            <div className="tabs" role="tablist" aria-label="Статус заявки">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className="tab" onClick={() => setTab(t.id)}>
                  {t.label}
                  {counts[t.id] > 0 && <span className="count">{counts[t.id]}</span>}
                </button>
              ))}
            </div>
          )}
        </header>

        <ErrorNote>{error}</ErrorNote>
        {notice && <p className="note" role="status">{notice}</p>}
        {leads === null && !error && <p className="muted pad">Загружаем заявки…</p>}

        {leads !== null && visible.length === 0 && (
          <div className="pad">
            {query || filtersOn ? (
              <p className="muted">Ничего не найдено.</p>
            ) : !hasChannels && workspace.role === "owner" && leads.length === 0 ? (
              <Empty title="Заявок пока нет">
                <p>Подключите соцсеть в разделе «Каналы» и напишите своему боту. Первая заявка появится здесь.</p>
                <button type="button" className="button" onClick={() => navigate("/channels")}>
                  Подключить канал
                </button>
              </Empty>
            ) : (
              <p className="muted">В этом разделе пока пусто.</p>
            )}
          </div>
        )}

        <ul className="rows">
          {visible.map((lead) => (
            <li key={lead.id}>
              <button
                type="button"
                className={`row ${lead.id === leadId ? "is-selected" : ""}`}
                aria-current={lead.id === leadId ? "true" : undefined}
                onClick={() => (selecting ? togglePick(lead.id) : navigate(`/leads/${lead.id}`))}
              >
                {selecting && <input type="checkbox" checked={picked.has(lead.id)} readOnly tabIndex={-1} aria-label={`Выбрать: ${contactName(lead)}`} />}
                {lead.channels && <ChannelTag platform={lead.channels.platform} />}
                <span className="row-main">
                  <span className="row-name">{contactName(lead)}</span>
                  <span className="row-preview">{lead.last_message_preview || "Нет сообщений"}</span>
                  {(isOverdue(lead) || lead.tags?.length > 0 || (lead.follow_up_at && lead.status !== "done")) && (
                    <span className="row-meta">
                      {isOverdue(lead) ? (
                        <span className="chip chip-bad">Просрочено: вернуться {shortTime(lead.follow_up_at!)}</span>
                      ) : lead.follow_up_at && (lead.status === "new" || lead.status === "in_work") ? (
                        <span className="chip">Вернуться {shortTime(lead.follow_up_at)}</span>
                      ) : null}
                      {lead.tags?.slice(0, 3).map((t) => (
                        <span className="chip" key={t}>{t}</span>
                      ))}
                    </span>
                  )}
                </span>
                <span className="row-side">
                  <time dateTime={lead.last_message_at}>{shortTime(lead.last_message_at)}</time>
                  {lead.unread_count > 0 && lead.status !== "collecting" && (
                    <span className="count count-strong" aria-label={`Непрочитанных: ${lead.unread_count}`}>
                      {lead.unread_count}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {showStats && (
        <Modal title="Какой источник приносит больше" onClose={() => setShowStats(false)}>
          <LeadStats />
        </Modal>
      )}

      <section className="lead-detail" aria-label="Заявка">
        {selected ? (
          <LeadDetail key={selected.id} lead={selected} onChanged={load} onBack={() => navigate("/leads")} />
        ) : (
          <div className="detail-empty">
            <p>{leadId && leads !== null ? "Заявка не найдена." : "Выберите заявку, чтобы увидеть ответы и переписку."}</p>
          </div>
        )}
      </section>
    </div>
  );
}

function LeadLessons({ lead }: { lead: Lead }) {
  const { workspace } = useApp();
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [joined, setJoined] = useState<LessonStudent[]>([]);
  const [lessonId, setLessonId] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [l, s] = await Promise.all([
      supabase.from("lessons").select("*").eq("workspace_id", workspace.id).order("starts_at", { ascending: true, nullsFirst: false }),
      supabase.from("lesson_students").select("*").eq("contact_id", lead.contact_id),
    ]);
    if (l.error || s.error) {
      setError((l.error ?? s.error)!.message);
      return;
    }
    setLessons(l.data as Lesson[]);
    setJoined(s.data as LessonStudent[]);
  }, [workspace.id, lead.contact_id]);

  useEffect(() => {
    load();
  }, [load]);

  async function add() {
    if (!lessonId) return;
    setError("");
    const { error: e } = await supabase.from("lesson_students").insert({
      workspace_id: workspace.id,
      lesson_id: lessonId,
      contact_id: lead.contact_id,
      name: contactName(lead),
      phone: lead.contacts?.phone ?? null,
    });
    if (e) setError(e.code === "23505" ? "Клиент уже записан на этот урок." : e.message);
    setLessonId("");
    load();
  }

  const joinedIds = new Set(joined.map((s) => s.lesson_id));
  const debtOf = (id: string) => joined.find((s) => s.lesson_id === id)?.debt ?? 0;
  const available = lessons.filter((l) => !joinedIds.has(l.id) && (!l.starts_at || new Date(l.starts_at).getTime() > Date.now() - 86_400_000));

  return (
    <section className="lead-lessons" aria-label="Уроки клиента">
      <h3>Уроки</h3>
      <ErrorNote>{error}</ErrorNote>
      {lessons.filter((l) => joinedIds.has(l.id)).map((l) => (
        <Link key={l.id} to={`/lessons/${l.id}`} className="lesson-link">
          {l.title}
          {l.starts_at && <span className="muted">, {fullTime(l.starts_at)}</span>}
          {debtOf(l.id) > 0 && <span className="debt">, долг {money(debtOf(l.id))}</span>}
        </Link>
      ))}
      {lessons.length === 0 ? (
        <p className="muted">Уроков пока нет. <Link to="/lessons/new">Создать урок</Link></p>
      ) : (
        <div className="lesson-add">
          <select value={lessonId} onChange={(e) => setLessonId(e.target.value)} aria-label="Выберите урок">
            <option value="">Записать на урок…</option>
            {available.map((l) => (
              <option key={l.id} value={l.id}>
                {l.title}{l.starts_at ? `, ${fullTime(l.starts_at)}` : ""}
              </option>
            ))}
          </select>
          <button type="button" className="button" onClick={add} disabled={!lessonId}>
            Записать
          </button>
        </div>
      )}
    </section>
  );
}

function LeadDetail({ lead, onChanged, onBack }: { lead: Lead; onChanged: () => Promise<void> | void; onBack: () => void }) {
  const { userId, workspace } = useApp();
  const [answers, setAnswers] = useState<Answer[]>([]);
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [current, setCurrent] = useState<Question | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState(lead.note ?? "");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const chatList = useRef<HTMLOListElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const [panel, setPanel] = useState<"sheet" | "chat">("sheet");

  const loadDetail = useCallback(async () => {
    const [a, m] = await Promise.all([
      supabase.from("answers").select("*").eq("lead_id", lead.id).order("position"),
      supabase.from("messages").select("*").eq("lead_id", lead.id).order("created_at"),
    ]);
    if (a.error || m.error) {
      setError(`Не удалось загрузить заявку: ${(a.error ?? m.error)!.message}`);
      return;
    }
    setAnswers(a.data as Answer[]);
    setMessages(m.data as Message[]);
    return m.data as Message[];
  }, [lead.id]);

  useEffect(() => {
    loadDetail();
    const live = supabase
      .channel(`lead-${lead.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `lead_id=eq.${lead.id}` }, () => loadDetail())
      .on("postgres_changes", { event: "*", schema: "public", table: "answers", filter: `lead_id=eq.${lead.id}` }, () => loadDetail())
      .subscribe();
    const timer = setInterval(loadDetail, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [lead.id, loadDetail]);

  // Обновление счётчика и подгрузка переписки зависят только от изменений заявки, а не от ввода в полях.
  useEffect(() => {
    if (lead.unread_count > 0) {
      supabase.rpc("mark_lead_read", { p_lead_id: lead.id }).then(() => onChanged());
    }
    loadDetail();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lead.id, lead.unread_count, lead.last_message_at, lead.status]);

  useEffect(() => {
    if (!lead.current_question_id) {
      setCurrent(null);
      return;
    }
    supabase.from("questions").select("*").eq("id", lead.current_question_id).maybeSingle().then(({ data }) => setCurrent(data as Question | null));
  }, [lead.current_question_id]);

  useEffect(() => {
    supabase.from("workspace_members").select("user_id, email, role, created_at").eq("workspace_id", workspace.id).then(({ data }) => setMembers((data ?? []) as Member[]));
  }, [workspace.id]);

  const messageCount = messages?.length ?? 0;
  useEffect(() => {
    // Прокручиваем только саму переписку: на телефоне страница остаётся на анкете.
    const list = chatList.current;
    if (list) list.scrollTop = list.scrollHeight;
    if (panel === "chat" && window.matchMedia("(max-width: 860px)").matches) {
      // Форма ответа прилипает к низу, поэтому прокручиваем сам раздел заявки к последнему сообщению.
      composer.current?.closest(".lead-detail")?.scrollTo(0, 1_000_000);
    }
  }, [messageCount, panel]);

  async function run(action: () => PromiseLike<{ error: { message: string } | null }>) {
    setBusy(true);
    setError("");
    const { error: e } = await action();
    if (e) setError(e.message);
    await onChanged();
    setBusy(false);
  }

  const take = () => run(() => supabase.rpc("take_lead", { p_lead_id: lead.id }));
  const setStatus = (status: LeadStatus) => run(() => supabase.rpc("set_lead_status", { p_lead_id: lead.id, p_status: status }));

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError("");
    let failure = "";
    try {
      await callFunction("send-message", { lead_id: lead.id, text });
      setDraft("");
    } catch (e) {
      failure = errorText(e);
    }
    const [fresh] = await Promise.all([loadDetail(), onChanged()]);
    // Если сообщение сохранилось как недоставленное, причина уже показана прямо под ним.
    if (failure && !fresh?.some((m) => m.status === "failed" && m.error === failure)) setError(failure);
    setSending(false);
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  }

  async function saveNote() {
    if (note === (lead.note ?? "")) return;
    const { error: e } = await supabase.rpc("set_lead_note", { p_lead_id: lead.id, p_note: note });
    if (e) setError(e.message);
    else onChanged();
  }

  const assignee = members.find((m) => m.user_id === lead.assigned_to);
  const platform = lead.channels?.platform;
  const profile = lead.contacts?.username ? `@${lead.contacts.username}` : null;

  return (
    <article className="detail">
      <header className="detail-head">
        <button type="button" className="icon-button back" onClick={onBack} aria-label="Назад к списку">
          <ArrowLeft size={20} aria-hidden />
        </button>
        <div className="detail-who">
          <h2>{contactName(lead)}</h2>
          <p>
            {platform && <ChannelTag platform={platform} />}
            <span>{lead.channels?.name}</span>
            {profile && <span>{profile}</span>}
            {lead.contacts?.phone && <a href={`tel:${lead.contacts.phone}`}>{lead.contacts.phone}</a>}
          </p>
        </div>
        <div className="detail-actions">
          <span className={`status status-${lead.status}`}>
            {STATUS_LABEL[lead.status]}
            {lead.status === "in_work" && assignee?.email ? `: ${assignee.user_id === userId ? "вы" : assignee.email}` : ""}
          </span>
          {(lead.status === "new" || lead.status === "collecting") && (
            <button type="button" className="button button-primary" onClick={take} disabled={busy}>
              Взять в работу
            </button>
          )}
          {lead.status === "in_work" && (
            <>
              {lead.assigned_to !== userId && (
                <button type="button" className="button" onClick={take} disabled={busy}>
                  Взять себе
                </button>
              )}
              <button type="button" className="button button-primary" onClick={() => setStatus("done")} disabled={busy}>
                Завершить
              </button>
              <button type="button" className="button" onClick={() => setStatus("rejected")} disabled={busy}>
                Отказ
              </button>
              <button type="button" className="link-button" onClick={() => setStatus("new")} disabled={busy}>
                Вернуть в новые
              </button>
            </>
          )}
          {(lead.status === "done" || lead.status === "rejected") && (
            <button type="button" className="button" onClick={() => setStatus("in_work")} disabled={busy}>
              Вернуть в работу
            </button>
          )}
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>
      <LeadMeta lead={lead} onChanged={onChanged} setError={setError} />
      {lead.handoff && lead.status === "new" && <p className="note note-attention">Клиент не смог пройти опрос или попросил живого человека. Ответьте ему лично.</p>}

      <div className="detail-switch" role="tablist" aria-label="Раздел заявки">
        <button type="button" role="tab" aria-selected={panel === "sheet"} onClick={() => setPanel("sheet")}>
          Анкета
        </button>
        <button type="button" role="tab" aria-selected={panel === "chat"} onClick={() => setPanel("chat")}>
          Переписка{messageCount > 0 ? ` (${messageCount})` : ""}
        </button>
      </div>

      <div className={`detail-columns show-${panel}`}>
        <div className="detail-sheet">
          <h3>Анкета</h3>
          <dl className="sheet">
            {answers.map((answer) => (
              <div className="sheet-row" key={answer.id}>
                <dt>{answer.question_text}</dt>
                <dd>{answer.answer_text ? <mark>{answer.answer_text}</mark> : <span className="muted">Пропущено</span>}</dd>
              </div>
            ))}
            {lead.status === "collecting" && current && (
              <div className="sheet-row">
                <dt>{current.text}</dt>
                <dd className="muted">Ждём ответ клиента</dd>
              </div>
            )}
            {answers.length === 0 && !(lead.status === "collecting" && current) && (
              <div className="sheet-row">
                <dd className="muted">Клиент не ответил ни на один вопрос.</dd>
              </div>
            )}
          </dl>
          <label className="field note-field">
            Заметка для команды
            <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} onBlur={saveNote} maxLength={4000} placeholder="Клиента не видит, только администраторы" />
          </label>
          <LeadLessons lead={lead} />
        </div>

        <div className="detail-chat">
          <h3>Переписка</h3>
          <ol className="chat" aria-live="polite" ref={chatList}>
            {messages === null && <li className="muted">Загружаем…</li>}
            {messages?.map((m) => (
              <li key={m.id} className={`bubble bubble-${m.sender}`}>
                {m.sender !== "contact" && <span className="bubble-who">{m.sender === "bot" ? "Бот" : "Администратор"}</span>}
                <p>{m.text ?? (m.attachment ? <em>{m.attachment}</em> : <em>Сообщение без текста</em>)}</p>
                {m.options?.length > 0 && (
                  <ul className="bubble-options">
                    {m.options.map((o) => (
                      <li key={o.id}>{o.label}</li>
                    ))}
                  </ul>
                )}
                <time dateTime={m.created_at} title={fullTime(m.created_at)}>
                  {shortTime(m.created_at)}
                </time>
                {m.status === "failed" && <span className="bubble-error" role="alert">Не доставлено. {m.error}</span>}
                {m.status === "queued" && <span className="muted">Отправляется…</span>}
              </li>
            ))}
          </ol>
          <QuickReplies
            onPick={(text) => {
              setDraft((current) => (current.trim() ? `${current.trimEnd()}\n${text}` : text));
              draftInput.current?.focus();
            }}
          />
          <form className="composer" onSubmit={send} ref={composer}>
            <textarea
              ref={draftInput}
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onComposerKey}
              placeholder={lead.status === "collecting" ? "Ответ остановит бота и закрепит заявку за вами" : "Ответить клиенту"}
              aria-label="Ответ клиенту"
              maxLength={4000}
            />
            <button className="button button-primary" disabled={sending || !draft.trim()} aria-label="Отправить">
              <Send size={18} aria-hidden />
            </button>
          </form>
        </div>
      </div>
    </article>
  );
}

/* ------------------------------------------------- Напоминание, теги, источник */

const toLocalInput = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function LeadMeta({ lead, onChanged, setError }: { lead: Lead; onChanged: () => Promise<void> | void; setError: (value: string) => void }) {
  const [tag, setTag] = useState("");
  const [source, setSource] = useState(lead.source ?? "");
  const open = lead.status === "new" || lead.status === "in_work";

  async function call(name: string, args: Record<string, unknown>) {
    setError("");
    const { error: e } = await supabase.rpc(name, args);
    if (e) setError(e.message);
    await onChanged();
  }

  const setFollowUp = (value: string) => call("set_lead_follow_up", { p_lead_id: lead.id, p_at: value ? new Date(value).toISOString() : null });
  const saveTags = (tags: string[]) => call("set_lead_tags", { p_lead_id: lead.id, p_tags: tags });

  function addTag() {
    const parts = tag.split(",").map((t) => t.trim()).filter(Boolean);
    setTag("");
    if (parts.length > 0) saveTags([...(lead.tags ?? []), ...parts]);
  }

  return (
    <div className="lead-meta">
      {open && (
        <label className="field field-inline">
          Вернуться к клиенту
          <input type="datetime-local" value={lead.follow_up_at ? toLocalInput(lead.follow_up_at) : ""} onChange={(e) => setFollowUp(e.target.value)} />
          {lead.follow_up_at && <button type="button" className="link-button" onClick={() => setFollowUp("")}>Убрать</button>}
          {isOverdue(lead) && <span className="chip chip-bad">Просрочено</span>}
        </label>
      )}
      <label className="field field-inline">
        Источник
        <input value={source} maxLength={60} onChange={(e) => setSource(e.target.value)} onBlur={() => source !== (lead.source ?? "") && call("set_lead_source", { p_lead_id: lead.id, p_source: source })} placeholder="Например, instagram_ads" />
      </label>
      <div className="tag-editor">
        <span className="tag-label">Теги</span>
        {(lead.tags ?? []).map((t) => (
          <span className="chip" key={t}>
            {t}
            <button type="button" className="chip-x" onClick={() => saveTags(lead.tags.filter((x) => x !== t))} aria-label={`Убрать тег ${t}`}>
              <X size={12} aria-hidden />
            </button>
          </span>
        ))}
        <input
          value={tag}
          maxLength={30}
          placeholder="Добавить тег"
          aria-label="Новый тег"
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addTag();
            }
          }}
          onBlur={addTag}
          disabled={(lead.tags ?? []).length >= 10}
        />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Статистика */

interface StatRow {
  name: string;
  total: number;
  done: number;
}

function LeadStats() {
  const { workspace } = useApp();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<{ by_source: StatRow[]; by_tag: StatRow[] } | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setData(null);
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const from = new Date(Date.now() - days * 86_400_000).toISOString();
    supabase.rpc("lead_stats", { p_workspace: workspace.id, p_from: from, p_to: to }).then(({ data: result, error: e }) => {
      if (e) setError(e.message);
      else setData(result as { by_source: StatRow[]; by_tag: StatRow[] });
    });
  }, [workspace.id, days]);

  const table = (rows: StatRow[], empty: string) =>
    rows.length === 0 ? (
      <p className="muted">{empty}</p>
    ) : (
      <table className="stat-table">
        <thead>
          <tr><th>Название</th><th>Заявок</th><th>Завершено</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.name}>
              <td>{PLATFORMS[r.name as keyof typeof PLATFORMS]?.label ?? r.name}</td>
              <td>{r.total}</td>
              <td>{r.done}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );

  return (
    <div className="stack">
      <label className="field">
        Период
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          <option value={7}>7 дней</option>
          <option value={30}>30 дней</option>
          <option value={90}>90 дней</option>
          <option value={365}>Год</option>
        </select>
      </label>
      <ErrorNote>{error}</ErrorNote>
      {!data && !error && <p className="muted">Считаем…</p>}
      {data && (
        <>
          <h3>По источникам</h3>
          {table(data.by_source, "За этот период заявок не было.")}
          <h3>По тегам</h3>
          {table(data.by_tag, "Теги ещё не ставили. Их можно добавить в карточке заявки.")}
        </>
      )}
    </div>
  );
}
