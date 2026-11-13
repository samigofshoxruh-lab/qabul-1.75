import { useCallback, useEffect, useState, type FormEvent } from "react";
import { UserPlus } from "lucide-react";
import { ErrorNote, Modal } from "../components/ui";
import { fullTime, randomPassword } from "../lib/format";
import { PERM_LABELS, ROLE_LABEL, ROLE_PRESETS, type PlatformPerms } from "../lib/platformPerms";
import { callFunction, errorText } from "../lib/supabase";

interface AdminRow extends PlatformPerms {
  user_id: string;
  email: string | null;
  is_active: boolean;
  created_at: string;
}

interface LogRow {
  id: string;
  actor_email: string | null;
  target_email: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

type PermFlags = Omit<PlatformPerms, "role">;
const flagsOf = (a: PermFlags): PermFlags => ({
  can_manage_companies: a.can_manage_companies,
  can_manage_access: a.can_manage_access,
  can_manage_users: a.can_manage_users,
  can_support: a.can_support,
  can_manage_admins: a.can_manage_admins,
});

/** Выбор роли и галочек. Готовая роль заполняет галочки, но их можно поправить: тогда это «свои права». */
function RoleEditor({ role, flags, onChange }: { role: PlatformPerms["role"]; flags: PermFlags; onChange: (role: PlatformPerms["role"], flags: PermFlags) => void }) {
  return (
    <div className="stack">
      <label className="field">
        Роль
        <select
          value={role}
          onChange={(e) => {
            const next = e.target.value as PlatformPerms["role"];
            onChange(next, next === "custom" ? flags : ROLE_PRESETS[next]);
          }}
        >
          {(Object.keys(ROLE_LABEL) as PlatformPerms["role"][]).map((r) => (
            <option key={r} value={r}>{ROLE_LABEL[r]}</option>
          ))}
        </select>
      </label>
      <fieldset className="perm-list">
        <legend>Права, которые вы выдаёте</legend>
        {PERM_LABELS.map((p) => (
          <label className="check perm" key={p.key}>
            <input type="checkbox" checked={flags[p.key]} onChange={(e) => onChange("custom", { ...flags, [p.key]: e.target.checked })} />
            <span>
              <strong>{p.label}</strong>
              <span className="muted"> — {p.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}

function AddAdmin({ onClose, onAdded }: { onClose: () => void; onAdded: (message: string) => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(randomPassword());
  const [role, setRole] = useState<PlatformPerms["role"]>("support");
  const [flags, setFlags] = useState<PermFlags>(ROLE_PRESETS.support);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", { action: "admin_add", email, password, role, permissions: flags });
      await onAdded(`Админ ${email} добавлен. Передайте ему email и пароль: ${password}`);
      onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title="Новый админ платформы" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
        </label>
        <label className="field">
          Пароль для первого входа
          <span className="inline-row">
            <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="off" required />
            <button type="button" className="button" onClick={() => setPassword(randomPassword())}>Другой</button>
          </span>
        </label>
        <RoleEditor role={role} flags={flags} onChange={(r, f) => { setRole(r); setFlags(f); }} />
        <ErrorNote>{error}</ErrorNote>
        <button className="button button-primary" disabled={busy || !email}>{busy ? "Добавляем…" : "Добавить админа"}</button>
      </form>
    </Modal>
  );
}

function AdminCard({ admin, isMe, onChanged, setError }: { admin: AdminRow; isMe: boolean; onChanged: (message?: string) => Promise<void>; setError: (value: string) => void }) {
  const [role, setRole] = useState<PlatformPerms["role"]>(admin.role);
  const [flags, setFlags] = useState<PermFlags>(flagsOf(admin));
  const [active, setActive] = useState(admin.is_active);
  const [busy, setBusy] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [password, setPassword] = useState(randomPassword());

  const dirty = role !== admin.role || active !== admin.is_active || JSON.stringify(flags) !== JSON.stringify(flagsOf(admin));

  async function call(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError("");
    try {
      await callFunction("platform", { ...body, user_id: admin.user_id });
      await onChanged(done);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`admin-card ${active ? "" : "is-off"}`}>
      <div className="admin-head">
        <strong>{admin.email}</strong>
        {isMe && <span className="muted"> (вы)</span>}
        {!admin.is_active && <span className="chip chip-bad">Отключён</span>}
        <span className="muted">Добавлен {fullTime(admin.created_at)}</span>
      </div>

      <RoleEditor role={role} flags={flags} onChange={(r, f) => { setRole(r); setFlags(f); }} />

      <label className="check">
        <input type="checkbox" checked={active} disabled={isMe} onChange={(e) => setActive(e.target.checked)} />
        Доступ включён
      </label>

      <div className="button-row">
        <button type="button" className="button button-primary" disabled={busy || !dirty} onClick={() => call({ action: "admin_update", role, permissions: flags, is_active: active }, `Права ${admin.email} сохранены.`)}>
          Сохранить права
        </button>
        <button type="button" className="link-button" onClick={() => setPasswordOpen(true)}>Сменить пароль</button>
        {!isMe && <button type="button" className="link-button link-danger" onClick={() => setRemoveOpen(true)}>Удалить</button>}
      </div>

      {passwordOpen && (
        <Modal title={`Новый пароль для ${admin.email}`} onClose={() => setPasswordOpen(false)}>
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await call({ action: "admin_set_password", password }, `Пароль ${admin.email} изменён: ${password}`)) setPasswordOpen(false);
            }}
          >
            <label className="field">
              Пароль
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} required />
            </label>
            <button className="button button-primary" disabled={busy}>Сменить пароль</button>
          </form>
        </Modal>
      )}
      {removeOpen && (
        <Modal title={`Удалить админа ${admin.email}?`} onClose={() => setRemoveOpen(false)}>
          <div className="stack">
            <p>Он больше не сможет войти в админку. Его ответы в поддержке останутся.</p>
            <div className="button-row">
              <button
                type="button" className="button button-danger" disabled={busy}
                onClick={async () => {
                  if (await call({ action: "admin_remove" }, `Админ ${admin.email} удалён.`)) setRemoveOpen(false);
                  else setRemoveOpen(false);
                }}
              >
                Удалить
              </button>
              <button type="button" className="button" onClick={() => setRemoveOpen(false)}>Оставить</button>
            </div>
          </div>
        </Modal>
      )}
    </li>
  );
}

export function PlatformAdminsPage() {
  const [admins, setAdmins] = useState<AdminRow[] | null>(null);
  const [log, setLog] = useState<LogRow[]>([]);
  const [me, setMe] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await callFunction<{ admins: AdminRow[]; log: LogRow[]; me: string }>("platform", { action: "admins_list" });
      setAdmins(data.admins);
      setLog(data.log);
      setMe(data.me);
    } catch (e) {
      setError(errorText(e));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <main className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Админы платформы</h1>
          <p className="muted">Каждому админу вы лично выдаёте права на нужные функции. Без отмеченного права кнопки ему не показываются, а сервер отклоняет действие.</p>
        </div>
        <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
          <UserPlus size={16} aria-hidden /> Добавить админа
        </button>
      </header>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note" role="status">{notice}</p>}
      {admins === null && !error && <p className="muted">Загружаем админов…</p>}

      <ul className="admin-list">
        {admins?.map((admin) => (
          <AdminCard
            key={`${admin.user_id}-${admin.role}-${admin.is_active}-${PERM_LABELS.map((p) => admin[p.key]).join("")}`}
            admin={admin}
            isMe={admin.user_id === me}
            setError={setError}
            onChanged={async (message) => {
              if (message) setNotice(message);
              await load();
            }}
          />
        ))}
      </ul>

      {log.length > 0 && (
        <section aria-label="Журнал">
          <h2 className="section-title">Кто и что выдавал</h2>
          <ul className="admin-log">
            {log.map((row) => (
              <li key={row.id}>
                <time dateTime={row.created_at}>{fullTime(row.created_at)}</time>
                <span>
                  {row.actor_email ?? "—"}: {row.action}
                  {row.target_email ? ` (${row.target_email})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {adding && <AddAdmin onClose={() => setAdding(false)} onAdded={async (message) => { setNotice(message); await load(); }} />}
    </main>
  );
}
