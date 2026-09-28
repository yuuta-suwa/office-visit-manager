"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile, UserRole } from "@/lib/types";

export default function UserManagement({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const isAdmin = currentUser.role === "admin";
  const [users, setUsers] = useState<Profile[]>([]);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteName, setInviteName] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("profiles").select("id,full_name,role").order("full_name");
    if (error) setError(error.message); else setUsers((data ?? []) as Profile[]);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  async function changeRole(user: Profile, role: UserRole) {
    setError(""); setMessage("");
    if (user.id === currentUser.id && role !== "admin" && !window.confirm("自分自身の管理者権限を外します。続行しますか？")) return;
    const { error } = await supabase.rpc("set_user_role", { p_user_id:user.id, p_role:role });
    if (error) {
      setError(error.message);
    } else {
      setMessage(`${user.full_name} の権限を変更しました。`);
      await load();
      if (user.id === currentUser.id) window.location.reload();
    }
  }

  async function toggleKeyManager(user: Profile) {
    const nextRole: UserRole = user.role === "key_manager" ? "member" : "key_manager";
    setError(""); setMessage("");
    if (user.id === currentUser.id && nextRole === "member" && !window.confirm("自分自身の鍵管理者権限を外します。続行しますか？")) return;
    const { error } = await supabase.rpc("set_user_role", { p_user_id:user.id, p_role:nextRole });
    if (error) {
      setError(error.message);
    } else {
      setMessage(`${user.full_name} を${nextRole === "key_manager" ? "鍵管理者" : "メンバー"}にしました。`);
      await load();
      if (user.id === currentUser.id) window.location.reload();
    }
  }

  async function inviteStaff(e: FormEvent) {
    e.preventDefault();
    setInviteError(""); setInviteMessage(""); setInviteBusy(true);
    try {
      const res = await fetch("/api/staff/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, full_name: inviteName }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setInviteError(body.error ?? "招待に失敗しました。");
      } else {
        setInviteMessage(`${inviteEmail} に招待メールを送信しました。`);
        setInviteEmail(""); setInviteName("");
        await load();
      }
    } catch {
      setInviteError("接続できませんでした。");
    } finally {
      setInviteBusy(false);
    }
  }

  const adminCount = users.filter(u => u.role === "admin").length;
  return <>
  <section className="card">
    <div className="section-head"><h2>スタッフ登録</h2></div>
    <p className="muted">メールアドレスを入力すると、招待メールが送信されます。招待先が自分でパスワードを設定してログインすると、自動的に「メンバー」として登録されます。</p>
    {inviteError && <div className="error">{inviteError}</div>}{inviteMessage && <div className="success">{inviteMessage}</div>}
    <form onSubmit={inviteStaff} className="event-form">
      <div className="form-grid">
        <div className="field">
          <label>氏名（任意）</label>
          <input value={inviteName} onChange={e => setInviteName(e.target.value)} />
        </div>
        <div className="field">
          <label>メールアドレス</label>
          <input type="email" required value={inviteEmail} onChange={e => setInviteEmail(e.target.value)} />
        </div>
      </div>
      <button className="btn btn-primary" disabled={inviteBusy}>{inviteBusy ? "送信中…" : "招待を送信"}</button>
    </form>
  </section>
  <section className="card">
    <div className="section-head"><h2>メンバー管理</h2><span className="badge">管理者 {adminCount}名 / 全{users.length}名</span></div>
    <p className="muted">初回登録ユーザーは必ず「メンバー」になります。管理者権限の付与・変更は管理者のみ実行できます。鍵管理者はメンバーとの切り替えを行えます。</p>
    {error && <div className="error">{error}</div>}{message && <div className="success">{message}</div>}
    <div className="table-wrap"><table><thead><tr><th>氏名</th><th>現在の権限</th><th>変更</th></tr></thead><tbody>{users.map(u => <tr key={u.id}><td>{u.full_name}{u.id === currentUser.id ? "（自分）" : ""}</td><td>{u.role === "admin" ? "管理者" : u.role === "key_manager" ? "鍵管理者" : "メンバー"}</td><td>{isAdmin ? (
      <select value={u.role} onChange={e => changeRole(u, e.target.value as UserRole)}><option value="member">メンバー</option><option value="key_manager">鍵管理者</option><option value="admin">管理者</option></select>
    ) : u.role === "admin" ? (
      <span className="muted">変更不可</span>
    ) : (
      <button className="btn" onClick={() => toggleKeyManager(u)}>{u.role === "key_manager" ? "メンバーに戻す" : "鍵管理者にする"}</button>
    )}</td></tr>)}</tbody></table></div>
  </section>
  </>;
}
