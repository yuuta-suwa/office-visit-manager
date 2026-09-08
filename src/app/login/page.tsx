"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  const supabase = createClient();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setMessage(error.message);
    } else {
      router.replace("/");
      router.refresh();
    }
    setBusy(false);
  }

  return (
    <main className="login-page">
      <section className="card login-card">
        <h1>来社管理アプリ</h1>
        <p className="muted">登録済みの社内アカウントでログインしてください。</p>
        <form onSubmit={submit}>
          <div className="field">
            <label>メールアドレス</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" required />
          </div>
          <div className="field">
            <label>パスワード</label>
            <input type="password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" required />
          </div>
          {message && <div className="error">{message}</div>}
          <button className="btn btn-primary" disabled={busy}>{busy ? "認証中…" : "ログイン"}</button>
        </form>
        <p className="muted" style={{marginTop:16}}>アカウント追加は管理者がSupabase Authenticationから行います。公開サインアップは使用しません。</p>
      </section>
    </main>
  );
}
