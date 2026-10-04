"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

type Phase = "checking" | "ready" | "invalid";

// Landing page for both staff invitations and password-reset emails: both
// arrive with the session tokens in the URL fragment, which this page turns
// into a real session before letting the person choose a password.
export default function SetPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("checking");
  const [problem, setProblem] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    (async () => {
      // Wait for the client's own URL detection to finish first, so it
      // cannot clear a session this page sets afterwards.
      await supabase.auth.getSession();

      const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
      const accessToken = params.get("access_token");
      const refreshToken = params.get("refresh_token");
      const linkError = params.get("error_description");

      if (accessToken && refreshToken) {
        const { error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        window.history.replaceState(null, "", window.location.pathname);
        if (error) {
          setProblem("リンクが無効か、期限が切れています。招待・再設定メールをもう一度送ってください。");
          setPhase("invalid");
          return;
        }
        setPhase("ready");
        return;
      }

      if (linkError) {
        window.history.replaceState(null, "", window.location.pathname);
        setProblem("リンクが無効か、期限が切れています。招待・再設定メールをもう一度送ってください。");
        setPhase("invalid");
        return;
      }

      const { data } = await supabase.auth.getSession();
      if (data.session) {
        setPhase("ready");
      } else {
        setProblem("メールのリンクから開いてください。");
        setPhase("invalid");
      }
    })();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage("");
    if (password !== confirm) {
      setMessage("パスワードが一致しません。");
      return;
    }
    setBusy(true);
    try {
      const { error } = await createClient().auth.updateUser({ password });
      if (error) {
        setMessage(error.message);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setMessage("接続できませんでした。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-page">
      <section className="card login-card">
        <h1>パスワードの設定</h1>
        {phase === "checking" && <p className="muted">確認中…</p>}
        {phase === "invalid" && (
          <>
            <div className="error">{problem}</div>
            <a className="btn" href="/login">ログイン画面へ</a>
          </>
        )}
        {phase === "ready" && (
          <>
            <p className="muted">今後ログインに使うパスワードを設定してください（8文字以上）。</p>
            <form onSubmit={submit}>
              <div className="field">
                <label>新しいパスワード</label>
                <input type="password" minLength={8} value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required />
              </div>
              <div className="field">
                <label>新しいパスワード（確認）</label>
                <input type="password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" required />
              </div>
              {message && <div className="error">{message}</div>}
              <button className="btn btn-primary" disabled={busy}>{busy ? "保存中…" : "パスワードを設定してログイン"}</button>
            </form>
          </>
        )}
      </section>
    </main>
  );
}
