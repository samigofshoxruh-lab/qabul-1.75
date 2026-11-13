import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { WEEKDAYS } from "../lib/recurrence";
import { useApp } from "../App";
import { ErrorNote, Modal } from "../components/ui";
import { errorText, supabase } from "../lib/supabase";
import type { Option, Question, QuestionType, Survey, Validation, WorkHours } from "../lib/types";

const randomId = () => crypto.randomUUID().replaceAll("-", "").slice(0, 10);

type Draft = Omit<Question, "survey_id" | "position">;

const newOption = (label = ""): Option => ({ id: randomId(), label });

function newQuestion(type: QuestionType, text = "", patch: Partial<Draft> = {}): Draft {
  return {
    id: crypto.randomUUID(),
    type,
    text,
    options: type === "choice" ? [newOption(), newOption()] : [],
    allow_other: false,
    required: true,
    text_uz: "",
    show_if: null,
    validation: "none",
    is_language: false,
    ...patch,
  };
}

const newLanguageQuestion = (): Draft =>
  newQuestion("choice", "Выберите язык / Tilni tanlang", {
    options: [{ id: "ru", label: "Русский" }, { id: "uz", label: "O'zbekcha" }],
    is_language: true,
  });

const VALIDATION_LABEL: Record<Validation, string> = {
  none: "Без проверки",
  number: "Только число",
  age: "Возраст (1–120)",
  email: "Адрес почты",
  phone_uz: "Телефон +998",
};

const SHOW_RULES: Record<string, Validation[]> = {
  text: ["none", "number", "age", "email", "phone_uz"],
  phone: ["none", "phone_uz"],
};

const COURSE_TEMPLATE = (): Draft[] => [
  newQuestion("choice", "Какой курс вас интересует?", {
    options: [newOption("Английский язык"), newOption("Программирование"), newOption("Подготовка к IELTS")],
    allow_other: true,
  }),
  newQuestion("choice", "Когда вам удобно прийти на первое занятие?", {
    options: [newOption("Суббота, 10:00"), newOption("Воскресенье, 12:00")],
    allow_other: true,
  }),
  newQuestion("text", "Как вас зовут?"),
  newQuestion("phone", "Оставьте номер телефона, чтобы мы подтвердили запись"),
  newQuestion("text", "Есть ли пожелания к занятиям?", { required: false }),
];

const TYPE_LABEL: Record<QuestionType, string> = {
  choice: "Выбор варианта",
  text: "Свободный ответ",
  phone: "Телефон",
};

function validate(questions: Draft[]): string {
  for (const [index, q] of questions.entries()) {
    const n = index + 1;
    if (q.is_language) continue;
    if (q.show_if) {
      const ref = questions.findIndex((x) => x.id === q.show_if!.question_id);
      if (ref < 0 || ref >= index || questions[ref].type !== "choice") return `Вопрос ${n}: условие показа должно опираться на один из предыдущих вопросов с вариантами.`;
      const known = new Set(questions[ref].options.map((o) => o.id));
      if (q.show_if.option_ids.length === 0 || q.show_if.option_ids.some((id) => !known.has(id))) return `Вопрос ${n}: выберите, при каких ответах показывать этот вопрос.`;
    }
    if (!q.text.trim()) return `Вопрос ${n}: напишите текст вопроса.`;
    if (q.type === "choice") {
      const labels = q.options.map((o) => o.label.trim());
      if (labels.some((l) => !l)) return `Вопрос ${n}: заполните все варианты или удалите пустые.`;
      if (labels.length < 2) return `Вопрос ${n}: нужно минимум два варианта.`;
      if (labels.length > 10) return `Вопрос ${n}: не больше десяти вариантов.`;
      if (new Set(labels.map((l) => l.toLowerCase())).size !== labels.length) return `Вопрос ${n}: варианты не должны повторяться.`;
    }
  }
  return "";
}

/** «Показывать, только если»: следующий вопрос зависит от ответа на один из предыдущих. */
function BranchEditor({ question, earlier, onChange }: { question: Draft; earlier: Draft[]; onChange: (value: Draft["show_if"]) => void }) {
  const sources = earlier.filter((q) => q.type === "choice" && !q.is_language);
  if (sources.length === 0) return null;
  const rule = question.show_if;
  const source = rule ? sources.find((q) => q.id === rule.question_id) : undefined;

  return (
    <div className="branch">
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(rule)}
          onChange={(e) => onChange(e.target.checked ? { question_id: sources[sources.length - 1].id, option_ids: [] } : null)}
        />
        Показывать только при определённом ответе
      </label>
      {rule && (
        <>
          <label className="field field-inline">
            Если ответ на вопрос
            <select value={rule.question_id} onChange={(e) => onChange({ question_id: e.target.value, option_ids: [] })}>
              {sources.map((q) => (
                <option key={q.id} value={q.id}>{earlier.indexOf(q) + 1}. {q.text.trim().slice(0, 50) || "Без текста"}</option>
              ))}
            </select>
          </label>
          <div className="branch-options" role="group" aria-label="Варианты ответа">
            {source?.options.filter((o) => o.label.trim()).map((o) => (
              <label className="check" key={o.id}>
                <input
                  type="checkbox"
                  checked={rule.option_ids.includes(o.id)}
                  onChange={(e) => onChange({ ...rule, option_ids: e.target.checked ? [...rule.option_ids, o.id] : rule.option_ids.filter((id) => id !== o.id) })}
                />
                {o.label}
              </label>
            ))}
          </div>
          <p className="muted">Если клиент выберет другой вариант или напишет свой, этот вопрос пропустится.</p>
        </>
      )}
    </div>
  );
}

/** Вне рабочего времени бот после анкеты отвечает «напишем утром», не чаще раза в 8 часов. */
function WorkHoursCard() {
  const { workspace } = useApp();
  const [hours, setHours] = useState<WorkHours | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    supabase.from("workspaces").select("work_hours").eq("id", workspace.id).maybeSingle().then(({ data }) => {
      setHours((data?.work_hours as WorkHours | null) ?? null);
      setLoaded(true);
    });
  }, [workspace.id]);

  if (!loaded) return null;

  const change = (patch: Partial<WorkHours>) => {
    setHours((h) => ({ ...(h as WorkHours), ...patch }));
    setSaved(false);
  };

  async function save() {
    setError("");
    const { error: e } = await supabase.rpc("set_work_hours", { p_workspace: workspace.id, p_hours: hours });
    if (e) setError(e.message.includes("рабочее время") ? "Проверьте рабочее время: начало должно быть раньше конца." : e.message);
    else setSaved(true);
  }

  return (
    <section className="form form-wide work-hours" aria-label="Рабочее время">
      <label className="check">
        <input
          type="checkbox"
          checked={Boolean(hours)}
          onChange={(e) => {
            setSaved(false);
            setHours(e.target.checked ? { from: "09:00", to: "18:00", days: [1, 2, 3, 4, 5, 6], text: "Сейчас мы не на связи. Напишем вам утром.", text_uz: "" } : null);
          }}
        />
        Рабочее время: вне него бот отвечает, что администратор напишет позже
      </label>
      {hours && (
        <>
          <div className="lesson-when">
            <label className="field">
              С
              <input type="time" value={hours.from} onChange={(e) => change({ from: e.target.value })} />
            </label>
            <label className="field">
              До
              <input type="time" value={hours.to} onChange={(e) => change({ to: e.target.value })} />
            </label>
          </div>
          <div className="weekday-row" role="group" aria-label="Рабочие дни">
            {WEEKDAYS.map((d) => {
              const id = d.id === 0 ? 7 : d.id;
              return (
                <button
                  type="button" key={d.id} title={d.long}
                  className={hours.days.includes(id) ? "is-yes" : ""}
                  aria-pressed={hours.days.includes(id)}
                  onClick={() => change({ days: hours.days.includes(id) ? hours.days.filter((x) => x !== id) : [...hours.days, id].sort() })}
                >
                  {d.short}
                </button>
              );
            })}
          </div>
          <label className="field">
            Что ответит бот
            <textarea rows={2} value={hours.text} maxLength={500} onChange={(e) => change({ text: e.target.value })} />
          </label>
          <label className="field">
            То же по-узбекски (для клиентов, выбравших узбекский)
            <textarea rows={2} value={hours.text_uz} maxLength={500} onChange={(e) => change({ text_uz: e.target.value })} />
          </label>
          <p className="muted">Время считается по Ташкенту.</p>
        </>
      )}
      <ErrorNote>{error}</ErrorNote>
      <div className="save-bar-row">
        <button type="button" className="button" onClick={save}>Сохранить рабочее время</button>
        {saved && <span role="status">Сохранено</span>}
      </div>
    </section>
  );
}

export function SurveysPage() {
  const { workspace } = useApp();
  const [surveys, setSurveys] = useState<Survey[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("surveys").select("*").eq("workspace_id", workspace.id).order("created_at");
    if (e) {
      setError(e.message);
      return;
    }
    setSurveys(data as Survey[]);
    setSelectedId((current) => current ?? (data as Survey[]).find((s) => s.is_default)?.id ?? data?.[0]?.id ?? null);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function createSurvey() {
    setError("");
    const { data, error: e } = await supabase
      .from("surveys")
      .insert({
        workspace_id: workspace.id,
        name: `Опрос ${(surveys?.length ?? 0) + 1}`,
        welcome_text: "Здравствуйте! Задам несколько коротких вопросов.",
        completion_text: "Спасибо! Администратор скоро свяжется с вами.",
      })
      .select()
      .single();
    if (e) {
      setError(e.message);
      return;
    }
    await load();
    setSelectedId(data.id);
  }

  const selected = surveys?.find((s) => s.id === selectedId) ?? null;

  return (
    <main className="page">
      <header className="page-head">
        <div>
          <h1>Вопросы</h1>
          <p className="muted">Бот задаёт их по порядку каждому, кто напишет в подключённый канал.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>

      {surveys && (
        <div className="tabs tabs-page">
          <div role="tablist" aria-label="Опросы" className="tabs-inner">
            {surveys.map((s) => (
              <button key={s.id} type="button" role="tab" aria-selected={s.id === selectedId} className="tab" onClick={() => setSelectedId(s.id)}>
                {s.name}
                {s.is_default && !s.name.toLowerCase().includes("основной") && <span className="muted"> (основной)</span>}
              </button>
            ))}
          </div>
          <button type="button" className="tab" onClick={createSurvey}>
            <Plus size={14} aria-hidden /> Новый опрос
          </button>
        </div>
      )}

      <WorkHoursCard />

      {selected && <SurveyEditor key={selected.id} survey={selected} onChanged={load} onDeleted={() => { setSelectedId(null); load(); }} />}
    </main>
  );
}

function SurveyEditor({ survey, onChanged, onDeleted }: { survey: Survey; onChanged: () => Promise<void> | void; onDeleted: () => void }) {
  const [name, setName] = useState(survey.name);
  const [welcome, setWelcome] = useState(survey.welcome_text ?? "");
  const [completion, setCompletion] = useState(survey.completion_text ?? "");
  const [questions, setQuestions] = useState<Draft[] | null>(null);
  const [savedIds, setSavedIds] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [multilingual, setMultilingual] = useState(survey.multilingual);
  const [welcomeUz, setWelcomeUz] = useState(survey.welcome_text_uz ?? "");
  const [completionUz, setCompletionUz] = useState(survey.completion_text_uz ?? "");
  const [stats, setStats] = useState<{ started: number; completed: number; questions: { id: string; answered: number; stuck: number }[] } | null>(null);

  useEffect(() => {
    supabase.rpc("survey_stats", { p_survey: survey.id }).then(({ data }) => {
      if (data) setStats(data as typeof stats);
    });
  }, [survey.id]);

  useEffect(() => {
    supabase
      .from("questions")
      .select("*")
      .eq("survey_id", survey.id)
      .order("position")
      .order("created_at")
      .then(({ data, error: e }) => {
        if (e) {
          setError(e.message);
          return;
        }
        setQuestions((data as Question[]).map((q) => ({ ...q, text_uz: q.text_uz ?? "", options: (q.options ?? []).map((o) => ({ ...o, label_uz: o.label_uz ?? "" })) })));
        setSavedIds((data ?? []).map((q) => q.id));
      });
  }, [survey.id]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const touch = () => {
    setDirty(true);
    setSaved(false);
  };

  function update(id: string, patch: Partial<Draft>) {
    setQuestions((list) => list!.map((q) => (q.id === id ? { ...q, ...patch } : q)));
    touch();
  }

  function setList(next: Draft[]) {
    // Удалённый вопрос или вариант не должен оставаться в условиях показа других вопросов.
    const cleaned = next.map((q) => {
      if (!q.show_if) return q;
      const ref = next.find((x) => x.id === q.show_if!.question_id);
      if (!ref) return { ...q, show_if: null };
      const ids = q.show_if.option_ids.filter((id) => ref.options.some((o) => o.id === id));
      return ids.length === q.show_if.option_ids.length ? q : { ...q, show_if: ids.length > 0 ? { ...q.show_if, option_ids: ids } : null };
    });
    setQuestions(cleaned);
    touch();
  }

  function toggleLanguages(on: boolean) {
    setMultilingual(on);
    const rest = (questions ?? []).filter((q) => !q.is_language);
    setList(on ? [newLanguageQuestion(), ...rest] : rest);
  }

  function move(index: number, delta: number) {
    const next = [...questions!];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    setList(next);
  }

  async function save() {
    const list = [...(questions ?? []).filter((q) => q.is_language), ...(questions ?? []).filter((q) => !q.is_language)];
    const problem = !name.trim() ? "Напишите название опроса." : validate(list);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { error: surveyError } = await supabase
        .from("surveys")
        .update({
          name: name.trim(),
          welcome_text: welcome.trim() || null,
          completion_text: completion.trim() || null,
          multilingual,
          welcome_text_uz: welcomeUz.trim() || null,
          completion_text_uz: completionUz.trim() || null,
        })
        .eq("id", survey.id);
      if (surveyError) throw surveyError;

      if (list.length > 0) {
        const { error: upsertError } = await supabase.from("questions").upsert(
          list.map((q, index) => ({
            id: q.id,
            survey_id: survey.id,
            position: index + 1,
            type: q.type,
            text: q.text.trim(),
            options: q.type === "choice" ? q.options.map((o) => ({ id: o.id, label: o.label.trim(), ...(o.label_uz?.trim() ? { label_uz: o.label_uz.trim() } : {}) })) : [],
            allow_other: q.type === "choice" && q.allow_other,
            required: q.is_language ? true : q.required,
            text_uz: q.text_uz?.trim() || null,
            show_if: q.show_if,
            validation: q.type === "choice" ? "none" : q.validation,
            is_language: q.is_language,
          })),
        );
        if (upsertError) throw upsertError;
      }

      const keep = new Set(list.map((q) => q.id));
      const removed = savedIds.filter((id) => !keep.has(id));
      if (removed.length > 0) {
        const { error: deleteError } = await supabase.from("questions").delete().in("id", removed);
        if (deleteError) throw deleteError;
      }

      setQuestions(list);
      setSavedIds(list.map((q) => q.id));
      setDirty(false);
      setSaved(true);
      await onChanged();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function makeDefault() {
    const { error: e } = await supabase.rpc("set_default_survey", { p_survey_id: survey.id });
    if (e) setError(e.message);
    else onChanged();
  }

  async function remove() {
    setConfirmDelete(false);
    const { error: e } = await supabase.from("surveys").delete().eq("id", survey.id);
    if (e) setError(e.message);
    else onDeleted();
  }

  const preview = useMemo(() => {
    const list = questions ?? [];
    return list.filter((q) => q.text.trim());
  }, [questions]);

  if (questions === null) return <p className="muted">Загружаем вопросы…</p>;

  return (
    <div className="editor">
      <div className="editor-main">
        <div className="form form-wide">
          <label className="field">
            Название
            <input value={name} onChange={(e) => { setName(e.target.value); touch(); }} maxLength={120} />
          </label>
          <label className="check">
            <input type="checkbox" checked={multilingual} onChange={(e) => toggleLanguages(e.target.checked)} />
            Два языка: русский и узбекский (клиент выбирает язык в начале)
          </label>
          <label className="field">
            Приветствие
            <textarea rows={2} value={welcome} onChange={(e) => { setWelcome(e.target.value); touch(); }} maxLength={900} placeholder="Первое сообщение бота. Можно оставить пустым." />
          </label>
          {multilingual && (
            <label className="field">
              Приветствие по-узбекски
              <textarea rows={2} value={welcomeUz} onChange={(e) => { setWelcomeUz(e.target.value); touch(); }} maxLength={900} />
            </label>
          )}
          {stats && stats.started > 0 && (
            <p className="muted">Начали анкету: {stats.started}, дошли до конца: {stats.completed}. Под вопросами видно, на каком клиенты останавливаются.</p>
          )}
        </div>

        <ol className="question-list">
          {questions.map((q, index) => (
            <li key={q.id} className="question">
              <div className="question-head">
                <span className="question-number">{index + 1}</span>
                <label className="field grow">
                  <span className="sr-only">Текст вопроса {index + 1}</span>
                  <textarea rows={2} value={q.text} readOnly={q.is_language} onChange={(e) => update(q.id, { text: e.target.value })} maxLength={900} placeholder="Текст вопроса" />
                </label>
                {multilingual && !q.is_language && (
                  <label className="field grow">
                    <span className="sr-only">Текст вопроса {index + 1} по-узбекски</span>
                    <textarea rows={2} value={q.text_uz ?? ""} onChange={(e) => update(q.id, { text_uz: e.target.value })} maxLength={900} placeholder="Вопрос по-узбекски" />
                  </label>
                )}
                {!q.is_language && <div className="question-tools">
                  <button type="button" className="icon-button" onClick={() => move(index, -1)} disabled={index === 0 || Boolean(questions[index - 1]?.is_language)} aria-label={`Поднять вопрос ${index + 1}`}>
                    <ArrowUp size={18} aria-hidden />
                  </button>
                  <button type="button" className="icon-button" onClick={() => move(index, 1)} disabled={index === questions.length - 1} aria-label={`Опустить вопрос ${index + 1}`}>
                    <ArrowDown size={18} aria-hidden />
                  </button>
                  <button type="button" className="icon-button" onClick={() => setList(questions.filter((x) => x.id !== q.id))} aria-label={`Удалить вопрос ${index + 1}`}>
                    <Trash2 size={18} aria-hidden />
                  </button>
                </div>}
              </div>

              {q.is_language && <p className="muted">Этот вопрос добавлен автоматически: он задаёт язык, на котором бот пишет клиенту дальше.</p>}
              {stats?.questions.find((x) => x.id === q.id) && (() => {
                const st = stats.questions.find((x) => x.id === q.id)!;
                return (
                  <p className="muted question-stat">
                    Ответили: {st.answered}
                    {st.stuck > 0 && <span className="debt"> · Бросили на этом вопросе: {st.stuck}</span>}
                  </p>
                );
              })()}

              {!q.is_language && <div className="question-settings">
                <label className="field field-inline">
                  Тип ответа
                  <select
                    value={q.type}
                    onChange={(e) => {
                      const type = e.target.value as QuestionType;
                      update(q.id, { type, options: type === "choice" && q.options.length < 2 ? [newOption(), newOption()] : q.options });
                    }}
                  >
                    {(Object.keys(TYPE_LABEL) as QuestionType[]).map((t) => (
                      <option key={t} value={t}>
                        {TYPE_LABEL[t]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="check">
                  <input type="checkbox" checked={!q.required} onChange={(e) => update(q.id, { required: !e.target.checked })} />
                  Можно пропустить
                </label>
                {q.type === "choice" && (
                  <label className="check">
                    <input type="checkbox" checked={q.allow_other} onChange={(e) => update(q.id, { allow_other: e.target.checked })} />
                    Клиент может написать свой вариант
                  </label>
                )}
                {q.type !== "choice" && (
                  <label className="field field-inline">
                    Проверка ответа
                    <select value={q.validation} onChange={(e) => update(q.id, { validation: e.target.value as Validation })}>
                      {SHOW_RULES[q.type].map((v) => (
                        <option key={v} value={v}>{VALIDATION_LABEL[v]}</option>
                      ))}
                    </select>
                  </label>
                )}
              </div>}

              {!q.is_language && index > 0 && <BranchEditor question={q} earlier={questions.slice(0, index)} onChange={(show_if) => update(q.id, { show_if })} />}

              {q.type === "choice" && (
                <ul className="option-list">
                  {q.options.map((option, i) => (
                    <li key={option.id}>
                      <input
                        value={option.label}
                        readOnly={q.is_language}
                        aria-label={`Вариант ${i + 1}`}
                        placeholder={`Вариант ${i + 1}`}
                        maxLength={100}
                        onChange={(e) => update(q.id, { options: q.options.map((o) => (o.id === option.id ? { ...o, label: e.target.value } : o)) })}
                      />
                      {multilingual && !q.is_language && (
                        <input
                          value={option.label_uz ?? ""}
                          aria-label={`Вариант ${i + 1} по-узбекски`}
                          placeholder="По-узбекски"
                          maxLength={100}
                          onChange={(e) => update(q.id, { options: q.options.map((o) => (o.id === option.id ? { ...o, label_uz: e.target.value } : o)) })}
                        />
                      )}
                      {!q.is_language && <button
                        type="button"
                        className="icon-button"
                        disabled={q.options.length <= 2}
                        aria-label={`Удалить вариант ${i + 1}`}
                        onClick={() => update(q.id, { options: q.options.filter((o) => o.id !== option.id) })}
                      >
                        <Trash2 size={16} aria-hidden />
                      </button>}
                    </li>
                  ))}
                  {!q.is_language && q.options.length < 10 && (
                    <li>
                      <button type="button" className="link-button" onClick={() => update(q.id, { options: [...q.options, newOption()] })}>
                        <Plus size={14} aria-hidden /> Добавить вариант
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </li>
          ))}
        </ol>

        {questions.length === 0 && (
          <div className="empty">
            <h3>Вопросов пока нет</h3>
            <p>Без вопросов бот промолчит, а сообщение клиента сразу станет новой заявкой.</p>
            <button type="button" className="button" onClick={() => setList(COURSE_TEMPLATE())}>
              Заполнить примером про курсы
            </button>
          </div>
        )}

        <div className="add-question">
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("choice")])}>
            <Plus size={16} aria-hidden /> Вопрос с вариантами
          </button>
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("text")])}>
            <Plus size={16} aria-hidden /> Свободный ответ
          </button>
          <button type="button" className="button" onClick={() => setList([...questions, newQuestion("phone")])}>
            <Plus size={16} aria-hidden /> Телефон
          </button>
        </div>

        <div className="form form-wide">
          <label className="field">
            Сообщение после опроса
            <textarea rows={2} value={completion} onChange={(e) => { setCompletion(e.target.value); touch(); }} maxLength={900} placeholder="Можно оставить пустым." />
          </label>
          {multilingual && (
            <label className="field">
              Сообщение после опроса по-узбекски
              <textarea rows={2} value={completionUz} onChange={(e) => { setCompletionUz(e.target.value); touch(); }} maxLength={900} />
            </label>
          )}
        </div>

        <div className="save-bar">
          <ErrorNote>{error}</ErrorNote>
          <div className="save-bar-row">
            <button type="button" className="button button-primary" onClick={save} disabled={busy || !dirty}>
              Сохранить опрос
            </button>
            {dirty && <span className="muted">Есть несохранённые изменения</span>}
            {saved && !dirty && <span role="status">Опрос сохранён</span>}
            <span className="grow" />
            {!survey.is_default && (
              <>
                <button type="button" className="link-button" onClick={makeDefault}>
                  Сделать основным
                </button>
                <button type="button" className="link-button link-danger" onClick={() => setConfirmDelete(true)}>
                  Удалить опрос
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {confirmDelete && (
        <Modal title={`Удалить опрос «${survey.name}»?`} onClose={() => setConfirmDelete(false)}>
          <div className="stack">
            <p>Каналы этого опроса перейдут на основной. Заявки и ответы останутся.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" onClick={remove}>
                Удалить опрос
              </button>
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}

      <aside className="preview" aria-label="Как это увидит клиент">
        <h2>Как это увидит клиент</h2>
        <ol className="chat chat-preview">
          <li className="bubble bubble-contact">
            <p>Привет</p>
          </li>
          {welcome.trim() && (
            <li className="bubble bubble-bot">
              <p>{welcome}</p>
            </li>
          )}
          {preview.map((q) => (
            <li key={q.id} className="bubble bubble-bot">
              <p>
                {q.text}
                {q.type === "choice" && q.allow_other ? "\n\nВыберите вариант или напишите свой." : ""}
              </p>
              {(q.type === "choice" || !q.required) && (
                <ul className="bubble-options">
                  {q.type === "choice" && q.options.filter((o) => o.label.trim()).map((o) => <li key={o.id}>{o.label}</li>)}
                  {!q.required && <li>Пропустить</li>}
                </ul>
              )}
            </li>
          ))}
          {completion.trim() && (
            <li className="bubble bubble-bot">
              <p>{completion}</p>
            </li>
          )}
        </ol>
      </aside>
    </div>
  );
}
