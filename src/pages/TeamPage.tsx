import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useApp } from "../App";
import { ErrorNote, Modal } from "../components/ui";
import { callFunction, errorText, supabase } from "../lib/supabase";
import type { Member } from "../lib/types";

export function TeamPage() {
  const { workspace, userId, reloadWorkspace } = useApp();
  const isOwner = workspace.role === "owner";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState(workspace.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [removing, setRemoving] = useState<Member | null>(null);
  const [editing, setEditing] = useState<Member | null>(null);

  const load = useCallback(async () => {
    const { data, error: e } = await supabase.from("workspace_members").select("user_id, email, role, created_at, can_view_payments, can_edit_survey").eq("workspace_id", workspace.id).order("created_at");
    if (e) setError(e.message);
    else setMembers(data as Member[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function add(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await callFunction("team", { action: "add", workspace_id: workspace.id, email, password });
      setNotice(`Администратор ${email} добавлен. Передайте ему email и пароль для входа.`);
      setEmail("");
      setPassword("");
      await load();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(member: Member) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await callFunction("team", { action: "remove", workspace_id: workspace.id, user_id: member.user_id });
      setRemoving(null);
      await load();
    } catch (e) {
      setRemoving(null);
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function setPermissions(member: Member, patch: Partial<Pick<Member, "can_view_payments" | "can_edit_survey">>) {
    setError("");
    setNotice("");
    const next = { can_view_payments: member.can_view_payments, can_edit_survey: member.can_edit_survey, ...patch };
    const { error: e } = await supabase.rpc("set_member_permissions", {
      p_workspace: workspace.id,
      p_user: member.user_id,
      p_view_payments: next.can_view_payments,
      p_edit_survey: next.can_edit_survey,
    });
    if (e) setError(errorText(e));
    await load();
  }

  async function rename(event: FormEvent) {
    event.preventDefault();
    const { error: e } = await supabase.from("workspaces").update({ name: company.trim() }).eq("id", workspace.id);
    if (e) setError(e.message);
    else {
      setNotice("Название сохранено.");
      reloadWorkspace();
    }
  }

  return (
    <main className="page page-narrow">
      <header className="page-head">
        <div>
          <h1>Команда</h1>
          <p className="muted">Администраторы видят заявки и отвечают клиентам. Каналы подключает только владелец. Оплаты и анкету владелец открывает администратору галочками.</p>
        </div>
      </header>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note" role="status">{notice}</p>}

      <ul className="member-list">
        {members?.map((member) => (
          <li key={member.user_id}>
            <span>
              <strong>{member.email}</strong>
              {member.user_id === userId && <span className="muted"> (вы)</span>}
            </span>
            <span className="muted">{member.role === "owner" ? "Владелец" : "Администратор"}</span>
            {member.role !== "owner" && (
              <span className="muted member-summary">{[member.can_view_payments && "Оплаты", member.can_edit_survey && "Анкета"].filter(Boolean).join(", ") || "Без особых прав"}</span>
            )}
            {isOwner && member.role !== "owner" && (
              <span className="member-actions">
                <button type="button" className="button" onClick={() => setEditing(member)}>
                  Изменить права
                </button>
                <button type="button" className="link-button link-danger" onClick={() => setRemoving(member)}>
                  Удалить
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>

      {isOwner && (
        <>
          <h2 className="section-title">Добавить администратора</h2>
          <form className="form" onSubmit={add}>
            <label className="field">
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" required />
            </label>
            <label className="field">
              Пароль для первого входа
              <input type="text" value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} autoComplete="off" required />
            </label>
            <button className="button button-primary" disabled={busy}>
              Добавить
            </button>
          </form>

          <h2 className="section-title">Кабинет</h2>
          <form className="form" onSubmit={rename}>
            <label className="field">
              Название компании
              <input value={company} onChange={(e) => setCompany(e.target.value)} maxLength={120} required />
            </label>
            <button className="button" disabled={company.trim() === workspace.name || !company.trim()}>
              Сохранить название
            </button>
          </form>
        </>
      )}

      {editing && (
        <PermissionsDialog
          member={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            await setPermissions(editing, patch);
            setEditing(null);
          }}
        />
      )}

      {removing && (
        <Modal title="Удалить администратора?" onClose={() => setRemoving(null)}>
          <div className="stack">
            <p>{removing.email} больше не сможет войти. Его ответы клиентам останутся в истории заявок.</p>
            <div className="button-row">
              <button type="button" className="button button-danger" disabled={busy} onClick={() => remove(removing)}>
                Удалить
              </button>
              <button type="button" className="button" onClick={() => setRemoving(null)}>
                Оставить
              </button>
            </div>
          </div>
        </Modal>
      )}
    </main>
  );
}

/** Окно «Изменить права сотрудника»: отмечаете, что разрешено, и сохраняете одной кнопкой. */
function PermissionsDialog({
  member, onClose, onSave,
}: {
  member: Member;
  onClose: () => void;
  onSave: (patch: Pick<Member, "can_view_payments" | "can_edit_survey">) => Promise<void>;
}) {
  const [viewPayments, setViewPayments] = useState(member.can_view_payments);
  const [editSurvey, setEditSurvey] = useState(member.can_edit_survey);
  const [busy, setBusy] = useState(false);
  const changed = viewPayments !== member.can_view_payments || editSurvey !== member.can_edit_survey;

  return (
    <Modal title="Права сотрудника" onClose={onClose}>
      <div className="stack">
        <p className="account-email">{member.email}</p>
        <fieldset className="perm-list">
          <legend>Что разрешено</legend>
          <label className="check perm">
            <input type="checkbox" checked={viewPayments} onChange={(e) => setViewPayments(e.target.checked)} />
            <span>
              <strong>Видит оплаты</strong>
              <span className="muted"> — раздел «Оплаты», цены и суммы в уроках</span>
            </span>
          </label>
          <label className="check perm">
            <input type="checkbox" checked={editSurvey} onChange={(e) => setEditSurvey(e.target.checked)} />
            <span>
              <strong>Правит анкету</strong>
              <span className="muted"> — раздел «Вопросы»: вопросы бота, языки, рабочее время</span>
            </span>
          </label>
        </fieldset>
        <div className="popover-actions">
          <button
            type="button"
            className="button button-primary"
            disabled={busy || !changed}
            onClick={async () => {
              setBusy(true);
              await onSave({ can_view_payments: viewPayments, can_edit_survey: editSurvey });
              setBusy(false);
            }}
          >
            {busy ? "Сохраняем…" : "Сохранить"}
          </button>
          <button type="button" className="button" onClick={onClose}>Отмена</button>
        </div>
      </div>
    </Modal>
  );
}
