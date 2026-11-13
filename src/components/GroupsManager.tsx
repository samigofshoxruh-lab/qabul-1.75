import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useApp } from "../App";
import { ErrorNote } from "./ui";
import { errorText, supabase } from "../lib/supabase";
import type { StudentGroup, StudentGroupMember } from "../lib/types";

interface Client {
  id: string;
  display_name: string | null;
  username: string | null;
  phone: string | null;
}
const clientName = (c: Client) => c.display_name || (c.username ? `@${c.username}` : "") || c.phone || "Без имени";

/** Группы учеников: собрать один раз, потом добавлять в урок одной кнопкой. */
export function GroupsManager({ onChanged }: { onChanged: () => void }) {
  const { workspace } = useApp();
  const [groups, setGroups] = useState<StudentGroup[] | null>(null);
  const [members, setMembers] = useState<StudentGroupMember[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [query, setQuery] = useState("");
  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [g, m] = await Promise.all([
      supabase.from("student_groups").select("*").eq("workspace_id", workspace.id).order("name"),
      supabase.from("student_group_members").select("*").eq("workspace_id", workspace.id).order("created_at"),
    ]);
    if (g.error || m.error) {
      setError((g.error ?? m.error)!.message);
      return;
    }
    setGroups(g.data as StudentGroup[]);
    setMembers(m.data as StudentGroupMember[]);
  }, [workspace.id]);

  useEffect(() => {
    load();
    supabase.from("contacts").select("id, display_name, username, phone").eq("workspace_id", workspace.id).order("last_seen_at", { ascending: false }).limit(1000)
      .then(({ data }) => setClients((data ?? []) as Client[]));
  }, [load, workspace.id]);

  async function fail(result: { error: { message: string; code?: string } | null }, duplicate: string) {
    if (result.error) {
      setError(result.error.code === "23505" ? duplicate : result.error.message);
      return false;
    }
    setError("");
    await load();
    onChanged();
    return true;
  }

  async function createGroup(event: FormEvent) {
    event.preventDefault();
    const { data, error: e } = await supabase.from("student_groups").insert({ workspace_id: workspace.id, name: newName.trim() }).select().single();
    if (e) {
      setError(e.code === "23505" ? "Группа с таким названием уже есть." : errorText(e));
      return;
    }
    setNewName("");
    setOpenId((data as StudentGroup).id);
    await load();
    onChanged();
  }

  const current = groups?.find((g) => g.id === openId) ?? null;
  const currentMembers = members.filter((m) => m.group_id === openId);
  const joined = useMemo(() => new Set(currentMembers.map((m) => m.contact_id)), [currentMembers]);
  const found = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return clients.filter((c) => !joined.has(c.id) && [c.display_name, c.username, c.phone].some((v) => v?.toLowerCase().includes(q))).slice(0, 6);
  }, [clients, joined, query]);

  return (
    <div className="stack">
      <form className="group-create" onSubmit={createGroup}>
        <input value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} placeholder="Название новой группы" aria-label="Название новой группы" required />
        <button className="button button-primary" disabled={!newName.trim()}>Создать</button>
      </form>
      <ErrorNote>{error}</ErrorNote>
      {groups?.length === 0 && <p className="muted">Групп пока нет. Создайте первую, например «Английский A1, вечер».</p>}
      <ul className="group-list">
        {groups?.map((g) => (
          <li key={g.id}>
            <button type="button" className={`row ${g.id === openId ? "is-selected" : ""}`} onClick={() => setOpenId(g.id === openId ? null : g.id)}>
              <span className="row-name">{g.name}</span>
              <span className="muted">{members.filter((m) => m.group_id === g.id).length} уч.</span>
            </button>
          </li>
        ))}
      </ul>

      {current && (
        <div className="stack">
          <h3>{current.name}</h3>
          <ul className="group-members">
            {currentMembers.map((m) => (
              <li key={m.id}>
                <span>{m.name}{m.phone ? `, ${m.phone}` : ""}</span>
                <button type="button" className="icon-button" aria-label={`Убрать ${m.name} из группы`} onClick={async () => fail(await supabase.from("student_group_members").delete().eq("id", m.id), "")}>
                  <Trash2 size={16} aria-hidden />
                </button>
              </li>
            ))}
            {currentMembers.length === 0 && <li className="muted">В группе пока никого.</li>}
          </ul>
          <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Найти клиента из заявок" aria-label="Найти клиента" />
          {found.map((c) => (
            <button
              type="button" className="client-result" key={c.id}
              onClick={async () => {
                if (await fail(await supabase.from("student_group_members").insert({ workspace_id: workspace.id, group_id: current.id, contact_id: c.id, name: clientName(c), phone: c.phone }), "Он уже в группе.")) setQuery("");
              }}
            >
              <span className="row-name">{clientName(c)}</span>
              <Plus size={16} aria-hidden />
            </button>
          ))}
          <form
            className="group-create"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await fail(await supabase.from("student_group_members").insert({ workspace_id: workspace.id, group_id: current.id, name: manualName.trim(), phone: manualPhone.trim() || null }), "")) {
                setManualName("");
                setManualPhone("");
              }
            }}
          >
            <input value={manualName} onChange={(e) => setManualName(e.target.value)} placeholder="Имя вручную" aria-label="Имя ученика" required maxLength={200} />
            <input value={manualPhone} onChange={(e) => setManualPhone(e.target.value)} placeholder="Телефон" aria-label="Телефон ученика" maxLength={40} />
            <button className="button" disabled={!manualName.trim()}>Добавить</button>
          </form>
          <button
            type="button" className="link-button link-danger"
            onClick={async () => {
              if (!window.confirm(`Удалить группу «${current.name}»? Ученики из уроков не пропадут.`)) return;
              setOpenId(null);
              await fail(await supabase.from("student_groups").delete().eq("id", current.id), "");
            }}
          >
            Удалить группу
          </button>
        </div>
      )}
    </div>
  );
}
