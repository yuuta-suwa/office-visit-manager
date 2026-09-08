"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile, UserRole } from "@/lib/types";

export default function UserManagement({ currentUserId }: { currentUserId: string }) {
  const supabase = createClient();
  const [users, setUsers] = useState<Profile[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("profiles").select("id,full_name,role").order("full_name");
    if (error) setError(error.message); else setUsers((data ?? []) as Profile[]);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  async function changeRole(user: Profile, role: UserRole) {
    setError(""); setMessage("");
    if (user.id === currentUserId && role !== "admin" && !window.confirm("自分自身の管理者権限を外します。続行しますか？")) return;
    const { error } = await supabase.rpc("set_user_role", { p_user_id:user.id, p_role:role });
    if (error) {
      setError(error.message);
    } else {
      setMessage(`${user.full_name} の権限を変更しました。`);
      await load();
      if (user.id === currentUserId) window.location.reload();
    }
  }

  const adminCount = users.filter(u => u.role === "admin").length;
  return <section className="card">
    <div className="section-head"><h2>メンバー管理</h2><span className="badge">管理者 {adminCount}名 / 全{users.length}名</span></div>
    <p className="muted">初回登録ユーザーは必ず「メンバー」になります。権限変更は管理者のみ実行できます。</p>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
    <div className="table-wrap"><table><thead><tr><th>氏名</th><th>現在の権限</th><th>変更</th></tr></thead><tbody>{users.map(u => <tr key={u.id}><td>{u.full_name}{u.id === currentUserId ? "（自分）" : ""}</td><td>{u.role === "admin" ? "管理者" : u.role === "key_manager" ? "鍵管理者" : "メンバー"}</td><td><select value={u.role} onChange={e => changeRole(u, e.target.value as UserRole)}><option value="member">メンバー</option><option value="key_manager">鍵管理者</option><option value="admin">管理者</option></select></td></tr>)}</tbody></table></div>
  </section>;
}
