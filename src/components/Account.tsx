import { useEffect, useState, type FormEvent, type ReactNode } from "react";
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

/** Выход всегда через вопрос: случайное нажатие не должно выбрасывать из кабинета. */
export function SignOutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title="Выйти из аккаунта?" onClose={onClose}>
      <div className="stack">
        <p>Вы уверены? Чтобы войти снова, понадобится пароль.</p>
        <div className="form-actions">
          <button type="button" className="button button-primary" onClick={() => supabase.auth.signOut()}>
            Выйти
          </button>
          <button type="button" className="button" onClick={onClose}>
            Остаться
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Кнопка «Выйти» с подтверждением для экранов без бокового меню. */
export function SignOutButton({ className = "button", children = "Выйти" }: { className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <SignOutDialog onClose={() => setOpen(false)} />}
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
    <>
      <Modal title="Аккаунт" onClose={onClose}>
        <div className="stack">
          <p className="account-email">
            <UserRound size={18} aria-hidden /> <span>{email || "…"}</span>
          </p>
          <ChangePassword />
          <button type="button" className="button" onClick={() => setConfirmOut(true)}>
            <LogOut size={16} aria-hidden /> Выйти
          </button>
        </div>
      </Modal>
      {confirmOut && <SignOutDialog onClose={() => setConfirmOut(false)} />}
    </>
  );
}
