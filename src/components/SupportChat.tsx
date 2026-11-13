import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Paperclip, Send, Trash2 } from "lucide-react";
import { ErrorNote } from "./ui";
import { fullTime, shortTime } from "../lib/format";
import { errorText, supabase } from "../lib/supabase";
import { SUPPORT_CHANGED } from "../lib/support";
import type { SupportMessage, SupportTemplate } from "../lib/types";

const POLL_MS = 8_000;
const BUCKET = "support-attachments";
const MAX_FILE = 5 * 1024 * 1024;
const isImage = (name: string) => /\.(png|jpe?g|gif|webp)$/i.test(name);

/** Вложение: ссылка живёт час, файл лежит в приватном хранилище. */
function Attachment({ path, name }: { path: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    supabase.storage.from(BUCKET).createSignedUrl(path, 3600).then(({ data, error }) => {
      if (error || !data) setFailed(true);
      else setUrl(data.signedUrl);
    });
  }, [path]);
  if (failed) return <p className="muted">Вложение «{name}» недоступно.</p>;
  if (!url) return <p className="muted">Загружаем вложение…</p>;
  return isImage(name) ? (
    <a href={url} target="_blank" rel="noreferrer">
      <img className="support-image" src={url} alt={name} />
    </a>
  ) : (
    <a href={url} target="_blank" rel="noreferrer">{name}</a>
  );
}

interface Props {
  workspaceId: string;
  asPlatform: boolean;
  /** Текст, подставленный кнопкой быстрого запроса. Меняется вместе с ключом, чтобы один текст можно было выбрать снова. */
  preset?: { text: string; key: number } | null;
  /** Обновляется снаружи после автоматического сообщения, например о продлении. */
  reloadKey?: number;
  onActivity?: () => void;
  emptyText: string;
}

export function SupportChat({ workspaceId, asPlatform, preset, reloadKey, onActivity, emptyText }: Props) {
  const [messages, setMessages] = useState<SupportMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const list = useRef<HTMLOListElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const knownCount = useRef<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const [templates, setTemplates] = useState<SupportTemplate[]>([]);

  const loadStatus = useCallback(async () => {
    const { data } = await supabase.from("support_thread_state").select("status").eq("workspace_id", workspaceId).maybeSingle();
    setStatus((data?.status as "open" | "resolved") ?? "open");
  }, [workspaceId]);

  const loadTemplates = useCallback(async () => {
    if (!asPlatform) return;
    const { data } = await supabase.from("support_templates").select("id, title, text").order("created_at");
    setTemplates((data ?? []) as SupportTemplate[]);
  }, [asPlatform]);

  useEffect(() => {
    loadTemplates();
  }, [loadTemplates]);

  async function toggleStatus() {
    const next = status === "open" ? "resolved" : "open";
    const { error: e } = await supabase.rpc("support_set_status", { p_workspace: workspaceId, p_status: next });
    if (e) setError(e.message);
    else {
      setStatus(next);
      onActivity?.();
    }
  }

  async function saveTemplate() {
    const text = draft.trim();
    if (!text) return setError("Сначала напишите текст ответа в поле ниже, затем сохраните его как шаблон.");
    const title = window.prompt("Название шаблона", text.slice(0, 30));
    if (!title?.trim()) return;
    const { error: e } = await supabase.from("support_templates").insert({ title: title.trim().slice(0, 60), text });
    if (e) setError(e.message);
    else await loadTemplates();
  }

  async function removeTemplate(template: SupportTemplate) {
    if (!window.confirm(`Удалить шаблон «${template.title}»?`)) return;
    await supabase.from("support_templates").delete().eq("id", template.id);
    await loadTemplates();
  }

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("support_messages").select("*").eq("workspace_id", workspaceId).order("created_at");
    if (e) {
      setError(`Не удалось загрузить переписку: ${e.message}`);
      return;
    }
    setError("");
    setMessages(data as SupportMessage[]);
    loadStatus();
    // Новое сообщение могло прийти вместе с продлением: сайт сразу перечитает срок.
    if (knownCount.current !== null && knownCount.current !== data.length) {
      window.dispatchEvent(new Event(SUPPORT_CHANGED));
    }
    knownCount.current = data.length;
    const incoming = asPlatform ? "owner" : "platform";
    if ((data as SupportMessage[]).some((m) => m.sender === incoming && !m.read_at)) {
      await supabase.rpc("support_mark_read", { p_workspace: workspaceId, p_as_platform: asPlatform });
      window.dispatchEvent(new Event(SUPPORT_CHANGED));
      onActivity?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, asPlatform]);

  useEffect(() => {
    load();
    const live = supabase
      .channel(`support-${workspaceId}-${asPlatform}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "support_messages", filter: `workspace_id=eq.${workspaceId}` }, () => load())
      .subscribe();
    const timer = setInterval(load, POLL_MS);
    return () => {
      supabase.removeChannel(live);
      clearInterval(timer);
    };
  }, [workspaceId, asPlatform, load, reloadKey]);

  useEffect(() => {
    if (preset) {
      setDraft(preset.text);
      input.current?.focus();
    }
  }, [preset]);

  const count = messages?.length ?? 0;
  useEffect(() => {
    if (list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [count]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    const text = draft.trim();
    if ((!text && !file) || sending) return;
    setSending(true);
    setError("");
    try {
      let attachmentPath: string | null = null;
      if (file) {
        const safe = file.name.replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "file";
        attachmentPath = `${workspaceId}/${crypto.randomUUID()}-${safe}`;
        const { error: uploadError } = await supabase.storage.from(BUCKET).upload(attachmentPath, file, { contentType: file.type || undefined });
        if (uploadError) throw new Error(`Не удалось загрузить файл: ${uploadError.message}`);
      }
      const { error: e } = await supabase.rpc("support_send", {
        p_workspace: workspaceId,
        p_text: text,
        p_as_platform: asPlatform,
        p_attachment_path: attachmentPath,
        p_attachment_name: file?.name ?? null,
      });
      if (e) throw e;
      setDraft("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      await load();
      onActivity?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    // На телефоне Enter переносит строку: отправка только кнопкой, как в мессенджерах.
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && !window.matchMedia("(max-width: 860px)").matches) {
      event.preventDefault();
      send();
    }
  }

  const mine = asPlatform ? "platform" : "owner";

  return (
    <div className="support-chat">
      <div className="support-state">
        <span className={`chip ${status === "resolved" ? "" : "chip-bad"}`}>{status === "resolved" ? "Решено" : "Открыто"}</span>
        <button type="button" className="link-button" onClick={toggleStatus}>
          {status === "resolved" ? "Открыть снова" : "Отметить решённым"}
        </button>
      </div>
      <ol className="chat support-list" ref={list} aria-live="polite">
        {messages === null && !error && <li className="muted">Загружаем переписку…</li>}
        {messages?.length === 0 && <li className="support-empty muted">{emptyText}</li>}
        {messages?.map((m) => (
          <li key={m.id} className={`bubble ${m.sender === mine ? "bubble-agent" : "bubble-contact"}`}>
            {m.sender !== mine && <span className="bubble-who">{m.sender === "platform" ? "Поддержка Qabul" : m.author_email ?? "Владелец"}</span>}
            {!(m.attachment_path && m.text === "Вложение") && <p>{m.text}</p>}
            {m.attachment_path && <Attachment path={m.attachment_path} name={m.attachment_name ?? "Файл"} />}
            <time dateTime={m.created_at} title={fullTime(m.created_at)}>
              {shortTime(m.created_at)}
            </time>
          </li>
        ))}
      </ol>
      <ErrorNote>{error}</ErrorNote>
      {asPlatform && (
        <div className="quick-row" role="group" aria-label="Быстрые ответы">
          <span className="quick-label">Шаблоны:</span>
          {templates.map((t) => (
            <span className="template-chip" key={t.id}>
              <button type="button" className="chip" onClick={() => { setDraft(t.text); input.current?.focus(); }}>{t.title}</button>
              <button type="button" className="chip-x" onClick={() => removeTemplate(t)} aria-label={`Удалить шаблон ${t.title}`}>
                <Trash2 size={12} aria-hidden />
              </button>
            </span>
          ))}
          <button type="button" className="link-button" onClick={saveTemplate}>Сохранить текст как шаблон</button>
        </div>
      )}
      {file && (
        <p className="muted support-file">
          Вложение: {file.name}{" "}
          <button type="button" className="link-button" onClick={() => { setFile(null); if (fileInput.current) fileInput.current.value = ""; }}>Убрать</button>
        </p>
      )}
      <form className="composer" onSubmit={send}>
        <input
          ref={fileInput}
          type="file"
          hidden
          accept="image/*,.pdf"
          onChange={(e) => {
            const picked = e.target.files?.[0] ?? null;
            if (picked && picked.size > MAX_FILE) {
              setError("Файл больше 5 МБ. Сожмите его или пришлите другой.");
              e.target.value = "";
              return;
            }
            setError("");
            setFile(picked);
          }}
        />
        <button type="button" className="button" onClick={() => fileInput.current?.click()} aria-label="Прикрепить файл или скриншот">
          <Paperclip size={18} aria-hidden />
        </button>
        <textarea
          ref={input}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          placeholder={asPlatform ? "Ответить владельцу" : "Напишите, чем мы можем помочь"}
          aria-label="Сообщение в поддержку"
          maxLength={4000}
        />
        <button className="button button-primary" disabled={sending || (!draft.trim() && !file)} aria-label="Отправить">
          <Send size={18} aria-hidden />
        </button>
      </form>
    </div>
  );
}
