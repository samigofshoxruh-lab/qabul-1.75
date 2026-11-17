import { useEffect, useRef, useState, type FormEvent, type MouseEvent, type ReactNode } from "react";
import { LogOut, UserRound } from "lucide-react";
import { ErrorNote, Modal } from "./ui";
import { errorText, supabase } from "../lib/supabase";

/** Почта вошедшего пользователя. */
export function useUserEmail(): string {
  const [email, setEmail] = useState("");
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setEmail(data.session?.user.email ?? ""));
  }, []);
  return email;
}

export interface AnchorRect {
  top: number;
  left: number;
  right: number;
  bottom: number;
  width: number;
}

export function rectOf(element: Element): AnchorRect {
  const r = element.getBoundingClientRect();
  return { top: r.top, left: r.left, right: r.right, bottom: r.bottom, width: r.width };
}

/**
 * Вопрос «Выйти?» появляется рядом с нажатой кнопкой и ничего не закрывает.
 * Слева от меню он выходит вправо, в нижнем меню телефона поднимается вверх.
 */
export function SignOutPopover({ rect, onClose }: { rect: AnchorRect; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const stayRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    stayRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && closeRef.current();
    const onDown = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Element)) return closeRef.current();
      if (ref.current?.contains(target) || target.closest("[data-signout-trigger]")) return;
      closeRef.current();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
    };
  }, []);

  const width = Math.min(290, window.innerWidth - 16);
  const phone = window.matchMedia("(max-width: 760px)").matches;
  const style = phone
    ? {
        width,
        bottom: window.innerHeight - rect.top + 10,
        left: Math.max(8, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)),
      }
    : { width, bottom: Math.max(8, window.innerHeight - rect.bottom), left: rect.right + 10 };

  return (
    <div className="popover" role="alertdialog" aria-label="Выйти из аккаунта" style={style} ref={ref}>
      <div>
        <h3>Выйти из аккаунта?</h3>
        <p>Чтобы войти снова, понадобится пароль.</p>
      </div>
      <div className="popover-actions">
        <button type="button" className="button button-primary" onClick={() => supabase.auth.signOut()}>
          Выйти
        </button>
        <button type="button" className="button" ref={stayRef} onClick={onClose}>
          Остаться
        </button>
      </div>
    </div>
  );
}

/** Кнопка «Выйти» с вопросом рядом для экранов без бокового меню. */
export function SignOutButton({ className = "button", children = "Выйти" }: { className?: string; children?: ReactNode }) {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  return (
    <>
      <button type="button" className={className} data-signout-trigger onClick={(e: MouseEvent<HTMLButtonElement>) => {
          // Положение кнопки считаем сразу: внутри функции обновления event.currentTarget уже пустой.
          const next = rectOf(e.currentTarget);
          setRect((current) => (current ? null : next));
        }}>
        {children}
      </button>
      {rect && <SignOutPopover rect={rect} onClose={() => setRect(null)} />}
    </>
  );
}

function ChangePassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    setDone(false);
    if (next.length < 8) return setError("Новый пароль должен быть не короче 8 символов.");
    if (next !== repeat) return setError("Новый пароль и повтор не совпадают.");
    if (next === current) return setError("Новый пароль совпадает с текущим.");
    setBusy(true);
    try {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email;
      if (!email) throw new Error("Не удалось определить почту. Войдите заново.");
      // Сначала убеждаемся, что текущий пароль верный: так чужая открытая вкладка не даст сменить пароль.
      const check = await supabase.auth.signInWithPassword({ email, password: current });
      if (check.error) {
        setError(check.error.code === "invalid_credentials" ? "Текущий пароль неверный." : errorText(check.error));
        return;
      }
      const { error: e } = await supabase.auth.updateUser({ password: next });
      if (e) {
        setError(e.code === "same_password" ? "Новый пароль совпадает с текущим." : e.code === "weak_password" ? "Пароль слишком простой. Добавьте цифры и буквы." : errorText(e));
        return;
      }
      setDone(true);
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <h3>Сменить пароль</h3>
      <label className="field">
        Текущий пароль
        <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
      </label>
      <label className="field">
        Новый пароль
        <input type="password" autoComplete="new-password" minLength={8} value={next} onChange={(e) => setNext(e.target.value)} required />
      </label>
      <label className="field">
        Повторите новый пароль
        <input type="password" autoComplete="new-password" minLength={8} value={repeat} onChange={(e) => setRepeat(e.target.value)} required />
      </label>
      <ErrorNote>{error}</ErrorNote>
      {done && <p className="note" role="status">Пароль изменён. Используйте его при следующем входе.</p>}
      <button className="button button-primary" disabled={busy || !current || !next || !repeat}>
        {busy ? "Сохраняем…" : "Сменить пароль"}
      </button>
    </form>
  );
}

export function AccountDialog({ onClose }: { onClose: () => void }) {
  const email = useUserEmail();
  const [confirmOut, setConfirmOut] = useState(false);
  return (
    <Modal title="Аккаунт" onClose={onClose}>
      <div className="stack">
        <p className="account-email">
          <UserRound size={18} aria-hidden /> <span>{email || "…"}</span>
        </p>
        <ChangePassword />
        {confirmOut ? (
          <div className="confirm-inline" role="alert">
            <p>Вы уверены? Чтобы войти снова, понадобится пароль.</p>
            <div className="popover-actions">
              <button type="button" className="button button-primary" onClick={() => supabase.auth.signOut()}>Выйти</button>
              <button type="button" className="button" onClick={() => setConfirmOut(false)}>Остаться</button>
            </div>
          </div>
        ) : (
          <button type="button" className="button" onClick={() => setConfirmOut(true)}>
            <LogOut size={16} aria-hidden /> Выйти
          </button>
        )}
      </div>
    </Modal>
  );
}
