import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Bell, Download, Search, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { Empty, ErrorNote } from "../components/ui";
import { csvCell, fullTime, money, moneyInput, parseMoney } from "../lib/format";
import { METHODS, METHOD_LABEL, monthRange, nowLocalInput } from "../lib/payments";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { LessonStudent, Payment, PaymentMethod } from "../lib/types";

type Row = LessonStudent & { lessons: { id: string; title: string; starts_at: string | null } | null };
type PaymentRow = Payment & { lesson_students: { name: string; lessons: { title: string } | null } | null };

interface Person {
  key: string;
  contactId: string | null;
  name: string;
  phone: string | null;
  paid: number;
  /** Долг за прошедшие уроки и уроки без даты. */
  debt: number;
  /** Ещё не наступившие уроки: это будущая оплата, а не долг. */
  upcoming: number;
  lines: Row[];
}

const PAGE = 1000;
const isUpcoming = (row: Row) => Boolean(row.lessons?.starts_at && new Date(row.lessons.starts_at).getTime() > Date.now());
const ATTENDED: Record<string, string> = { true: "пришёл", false: "не пришёл" };
const currentMonth = () => nowLocalInput().slice(0, 7);

type Tab = "debts" | "history" | "report";
const TABS: { id: Tab; label: string }[] = [
  { id: "debts", label: "Долги" },
  { id: "history", label: "История платежей" },
  { id: "report", label: "Отчёт за месяц" },
];

export function PaymentsPage() {
  const { workspace } = useApp();
  const [tab, setTab] = useState<Tab>("debts");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState("");
  const [month, setMonth] = useState(currentMonth());
  const [payments, setPayments] = useState<PaymentRow[] | null>(null);

  const loadRows = useCallback(async () => {
    const all: Row[] = [];
    // Supabase отдаёт не больше 1000 строк за раз, а итоги должны считаться по всем.
    for (let from = 0; ; from += PAGE) {
      const { data, error: e } = await supabase
        .from("lesson_students")
        .select("*, lessons(id, title, starts_at)")
        .eq("workspace_id", workspace.id)
        .or("price.gt.0,paid.gt.0")
        .order("created_at")
        .range(from, from + PAGE - 1);
      if (e) {
        setError(`Не удалось загрузить оплаты: ${e.message}`);
        return;
      }
      all.push(...(data as Row[]));
      if (data.length < PAGE) break;
    }
    setError("");
    setRows(all);
  }, [workspace.id]);

  const loadPayments = useCallback(async () => {
    const { from, to } = monthRange(month);
    const all: PaymentRow[] = [];
    for (let start = 0; ; start += PAGE) {
      const { data, error: e } = await supabase
        .from("payments")
        .select("*, lesson_students(name, lessons(title))")
        .eq("workspace_id", workspace.id)
        .gte("paid_at", from)
        .lt("paid_at", to)
        .order("paid_at", { ascending: false })
        .range(start, start + PAGE - 1);
      if (e) {
        setError(`Не удалось загрузить платежи: ${e.message}`);
        return;
      }
      all.push(...(data as unknown as PaymentRow[]));
      if (data.length < PAGE) break;
    }
    setPayments(all);
  }, [workspace.id, month]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    setPayments(null);
    loadPayments();
  }, [loadPayments]);

  const refresh = useCallback(() => Promise.all([loadRows(), loadPayments()]), [loadRows, loadPayments]);

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Оплаты</h1>
          <p className="muted">Кто сколько заплатил и кто должен. Цена, скидка и посещаемость отмечаются в уроке.</p>
        </div>
      </header>

      <div className="tabs tabs-page" role="tablist" aria-label="Разделы оплат">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      <ErrorNote>{error}</ErrorNote>

      {tab === "debts" && <DebtsTab rows={rows} onChanged={refresh} setError={setError} />}
      {tab === "history" && <HistoryTab month={month} setMonth={setMonth} payments={payments} onChanged={refresh} setError={setError} />}
      {tab === "report" && <ReportTab month={month} setMonth={setMonth} payments={payments} />}
    </main>
  );
}

/* ------------------------------------------------------------------ Долги */

function DebtsTab({ rows, onChanged, setError }: { rows: Row[] | null; onChanged: () => Promise<unknown>; setError: (value: string) => void }) {
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [reminded, setReminded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState("");

  const people = useMemo(() => {
    const map = new Map<string, Person>();
    for (const row of rows ?? []) {
      const key = row.contact_id ?? `${row.name.trim().toLowerCase()}|${row.phone ?? ""}`;
      const person = map.get(key) ?? { key, contactId: row.contact_id, name: row.name, phone: row.phone, paid: 0, debt: 0, upcoming: 0, lines: [] };
      person.paid += row.paid;
      if (isUpcoming(row)) person.upcoming += row.debt;
      else person.debt += row.debt;
      if (row.debt > 0) person.lines.push(row);
      map.set(key, person);
    }
    return [...map.values()].sort((a, b) => b.debt - a.debt || b.upcoming - a.upcoming);
  }, [rows]);

  const totals = useMemo(
    () => people.reduce((sum, p) => ({ paid: sum.paid + p.paid, debt: sum.debt + p.debt, upcoming: sum.upcoming + p.upcoming }), { paid: 0, debt: 0, upcoming: 0 }),
    [people],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return people.filter((p) => p.lines.length > 0 && (!q || p.name.toLowerCase().includes(q) || p.phone?.includes(q)));
  }, [people, query]);

  async function remind(person: Person) {
    if (!person.contactId) return;
    const overdue = person.lines.filter((r) => !isUpcoming(r));
    const list = overdue.map((r) => `• ${r.lessons?.title ?? "Урок"}: ${money(r.debt)}`).join("\n");
    const text = `Здравствуйте, ${person.name}! Напоминаем о задолженности: ${money(person.debt)}.\n${list}\nЕсли вы уже оплатили, просто напишите нам.`;
    if (!window.confirm(`Отправить ${person.name} напоминание о долге ${money(person.debt)} в его канал?`)) return;
    setBusy(person.key);
    setError("");
    try {
      const { data: leads, error: e } = await supabase.from("leads").select("id").eq("contact_id", person.contactId).order("created_at", { ascending: false }).limit(1);
      if (e) throw e;
      if (!leads?.[0]) throw new Error("У клиента нет заявки, поэтому написать ему не получится.");
      await callFunction("send-message", { lead_id: leads[0].id, text });
      setReminded((prev) => new Set(prev).add(person.key));
    } catch (e) {
      setError(`Напоминание не отправлено: ${errorText(e)}`);
    }
    setBusy("");
  }

  if (rows === null) return <p className="muted">Загружаем оплаты…</p>;
  if (rows.length === 0) {
    return (
      <Empty title="Оплат пока нет">
        <p>Укажите цену в <Link to="/lessons">уроке</Link>, и здесь появятся ученики, которые ещё не заплатили.</p>
      </Empty>
    );
  }

  return (
    <>
      <div className="pay-stats">
        <div className="pay-stat"><span>Оплачено</span><strong>{money(totals.paid)}</strong></div>
        <div className="pay-stat"><span>Долг</span><strong className={totals.debt > 0 ? "debt" : ""}>{money(totals.debt)}</strong></div>
        <div className="pay-stat"><span>Ожидается за будущие уроки</span><strong>{money(totals.upcoming)}</strong></div>
      </div>

      <label className="search pay-search">
        <Search size={16} aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Имя или телефон" aria-label="Найти ученика" />
      </label>

      {visible.length === 0 && <p className="muted pad">{query.trim() ? "Никого не нашли." : "Все ученики оплатили уроки."}</p>}

      <ul className="pay-people">
        {visible.map((person) => (
          <li className="pay-person" key={person.key}>
            <div className="pay-head">
              <span>
                <strong>{person.name}</strong>
                {person.phone && <a href={`tel:${person.phone}`}>{person.phone}</a>}
              </span>
              <span className="pay-sum">
                {person.debt > 0 && <span className="debt">Долг {money(person.debt)}</span>}
                {person.debt > 0 && person.upcoming > 0 && ", "}
                {person.upcoming > 0 && <span className="muted">ожидается {money(person.upcoming)}</span>}
              </span>
            </div>
            <ul className="pay-lines">
              {person.lines.map((row) => (
                <li className="pay-line" key={row.id}>
                  <span>
                    <Link to={`/lessons/${row.lesson_id}`}>{row.lessons?.title}</Link>
                    <span className="muted">
                      {row.lessons?.starts_at ? `, ${fullTime(row.lessons.starts_at)}` : ""}
                      {row.attended !== null ? `, ${ATTENDED[String(row.attended)]}` : ""}
                      {row.discount > 0 ? `, скидка ${money(row.discount)}` : ""}
                      {row.paid > 0 ? `, уже оплачено ${money(row.paid)}` : ""}
                    </span>
                  </span>
                  <span className="pay-line-side">
                    <span className="pay-sum">{money(row.debt)}</span>
                    <button
                      type="button"
                      className="button"
                      onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      aria-expanded={openId === row.id}
                      aria-label={`Принять оплату: ${person.name}, ${row.lessons?.title ?? "урок"}`}
                    >
                      Принять оплату
                    </button>
                  </span>
                  {openId === row.id && (
                    <PayForm
                      row={row}
                      onDone={async () => {
                        setOpenId(null);
                        await onChanged();
                      }}
                      setError={setError}
                    />
                  )}
                </li>
              ))}
            </ul>
            {person.debt > 0 && (
              <div className="pay-people-actions">
                <button
                  type="button"
                  className="button"
                  disabled={!person.contactId || busy === person.key}
                  onClick={() => remind(person)}
                  title={person.contactId ? undefined : "Ученик добавлен вручную и не писал боту: напомнить через бота нельзя"}
                >
                  <Bell size={16} aria-hidden /> {reminded.has(person.key) ? "Напоминание отправлено" : busy === person.key ? "Отправляем…" : "Напомнить о долге"}
                </button>
                {!person.contactId && <p className="pay-hint">Напомнить через бота нельзя: ученик добавлен вручную.</p>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function PayForm({ row, onDone, setError }: { row: Row; onDone: () => Promise<void>; setError: (value: string) => void }) {
  const { workspace } = useApp();
  const [amount, setAmount] = useState(moneyInput(row.debt));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [when, setWhen] = useState(nowLocalInput());
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  const value = parseMoney(amount);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (value <= 0) return;
    setSaving(true);
    setError("");
    const { error: e } = await supabase.from("payments").insert({
      workspace_id: workspace.id,
      student_id: row.id,
      amount: value,
      method,
      note: note.trim() || null,
      paid_at: new Date(when).toISOString(),
    });
    setSaving(false);
    if (e) {
      setError(errorText(e));
      return;
    }
    await onDone();
  }

  return (
    <form className="pay-form" onSubmit={submit} style={{ flexBasis: "100%" }}>
      <label className="field">
        Сумма
        <input inputMode="numeric" value={amount} maxLength={17} onChange={(e) => setAmount(moneyInput(parseMoney(e.target.value)))} required />
      </label>
      <label className="field">
        Способ
        <select value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
          {METHODS.map((m) => (
            <option key={m.id} value={m.id}>{m.label}</option>
          ))}
        </select>
      </label>
      <label className="field">
        Когда
        <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required />
      </label>
      <label className="field">
        Комментарий
        <input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Например, чек Click №123" />
      </label>
      <div className="pay-form-actions">
        <button className="button" disabled={saving || value <= 0}>{saving ? "Сохраняем…" : "Записать платёж"}</button>
        <button type="button" className="button" onClick={() => setAmount(moneyInput(row.debt))}>Весь долг: {money(row.debt)}</button>
      </div>
      {(method === "payme" || method === "click") && (
        <p className="pay-hint" style={{ gridColumn: "1 / -1" }}>
          {METHOD_LABEL[method]} здесь только пометка для вашей бухгалтерии: Qabul деньги не принимает и платёж не проверяет.
        </p>
      )}
    </form>
  );
}

/* ---------------------------------------------------------------- История */

function MonthPicker({ month, setMonth }: { month: string; setMonth: (value: string) => void }) {
  return (
    <label className="field">
      Месяц
      <input type="month" value={month} max={currentMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} />
    </label>
  );
}

function HistoryTab({
  month, setMonth, payments, onChanged, setError,
}: {
  month: string;
  setMonth: (value: string) => void;
  payments: PaymentRow[] | null;
  onChanged: () => Promise<unknown>;
  setError: (value: string) => void;
}) {
  const [method, setMethod] = useState<"all" | PaymentMethod>("all");
  const shown = useMemo(() => (payments ?? []).filter((p) => method === "all" || p.method === method), [payments, method]);

  async function remove(payment: PaymentRow) {
    if (!window.confirm(`Удалить платёж ${money(payment.amount)} от ${payment.lesson_students?.name ?? "ученика"}? Долг ученика вырастет.`)) return;
    setError("");
    const { error: e } = await supabase.from("payments").delete().eq("id", payment.id);
    if (e) setError(errorText(e));
    await onChanged();
  }

  return (
    <>
      <div className="pay-toolbar">
        <MonthPicker month={month} setMonth={setMonth} />
        <label className="field">
          Способ
          <select value={method} onChange={(e) => setMethod(e.target.value as "all" | PaymentMethod)}>
            <option value="all">Все</option>
            {METHODS.map((m) => (
              <option key={m.id} value={m.id}>{m.label}</option>
            ))}
          </select>
        </label>
      </div>

      {payments === null && <p className="muted">Загружаем платежи…</p>}
      {payments !== null && shown.length === 0 && <p className="muted pad">В этом месяце платежей нет.</p>}

      {shown.length > 0 && (
        <ul className="pay-history">
          {shown.map((p) => (
            <li key={p.id}>
              <span>
                <strong>{p.lesson_students?.name ?? "Ученик"}</strong>
                <span className="muted">
                  {p.lesson_students?.lessons?.title ? `, ${p.lesson_students.lessons.title}` : ""}
                  {p.note ? `, ${p.note}` : ""}
                </span>
                <br />
                <span className="pay-method">{fullTime(p.paid_at)}, {METHOD_LABEL[p.method]}</span>
              </span>
              <span className="pay-line-side">
                <span className={`pay-sum ${p.amount < 0 ? "pay-negative" : ""}`}>{money(p.amount)}</span>
                <button type="button" className="icon-button" onClick={() => remove(p)} aria-label={`Удалить платёж ${money(p.amount)}`}>
                  <Trash2 size={16} aria-hidden />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/* ----------------------------------------------------------------- Отчёт */

function ReportTab({ month, setMonth, payments }: { month: string; setMonth: (value: string) => void; payments: PaymentRow[] | null }) {
  const report = useMemo(() => {
    const [y, m] = month.split("-").map(Number);
    const days = new Date(y, m, 0).getDate();
    const byDay = Array<number>(days).fill(0);
    const byMethod = new Map<PaymentMethod, number>();
    let total = 0;
    for (const p of payments ?? []) {
      total += p.amount;
      byDay[new Date(p.paid_at).getDate() - 1] += p.amount;
      byMethod.set(p.method, (byMethod.get(p.method) ?? 0) + p.amount);
    }
    return { days, byDay, byMethod, total };
  }, [month, payments]);

  const max = Math.max(...report.byDay, 1);

  function exportCsv() {
    const header = ["Дата", "Ученик", "Урок", "Сумма", "Способ", "Комментарий"];
    const lines = (payments ?? []).slice().reverse().map((p) =>
      [
        new Date(p.paid_at).toLocaleString("ru-RU"),
        p.lesson_students?.name ?? "",
        p.lesson_students?.lessons?.title ?? "",
        p.amount,
        METHOD_LABEL[p.method],
        p.note ?? "",
      ].map(csvCell).join(","),
    );
    const blob = new Blob(["\uFEFF" + [header.map(csvCell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `oplaty-${month}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  return (
    <>
      <div className="pay-toolbar">
        <MonthPicker month={month} setMonth={setMonth} />
        <button type="button" className="button" onClick={exportCsv} disabled={!payments || payments.length === 0}>
          <Download size={16} aria-hidden /> Скачать CSV
        </button>
      </div>

      {payments === null && <p className="muted">Загружаем отчёт…</p>}
      {payments !== null && payments.length === 0 && <p className="muted pad">В этом месяце платежей нет.</p>}

      {payments !== null && payments.length > 0 && (
        <>
          <div className="pay-stats">
            <div className="pay-stat"><span>Получено за месяц</span><strong>{money(report.total)}</strong></div>
            <div className="pay-stat"><span>Платежей</span><strong>{payments.length}</strong></div>
            <div className="pay-stat"><span>Средний платёж</span><strong>{money(Math.round(report.total / payments.length))}</strong></div>
          </div>

          <h3>По способам оплаты</h3>
          <div className="pay-methods">
            {METHODS.filter((m) => report.byMethod.has(m.id)).map((m) => (
              <div className="pay-stat" key={m.id}>
                <span>{m.label}</span>
                <strong>{money(report.byMethod.get(m.id) ?? 0)}</strong>
              </div>
            ))}
          </div>

          <h3>По дням</h3>
          <div className="pay-bars" role="img" aria-label={`График поступлений по дням, всего ${money(report.total)}`}>
            {report.byDay.map((sum, i) => (
              <div key={i} className="pay-bar" style={{ height: `${Math.max(sum, 0) / max * 100}%` }} title={`${i + 1}-е: ${money(sum)}`} />
            ))}
          </div>
          <div className="pay-bar-axis" aria-hidden>
            <span>1</span>
            <span>{Math.ceil(report.days / 2)}</span>
            <span>{report.days}</span>
          </div>
        </>
      )}
    </>
  );
}
