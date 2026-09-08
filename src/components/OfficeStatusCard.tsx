"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTokyoDateTime } from "@/lib/date";
import type { OfficeStatus, Profile } from "@/lib/types";

export default function OfficeStatusCard({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const [status, setStatus] = useState<OfficeStatus | null>(null);
  const [operator, setOperator] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("office_status").select("*").eq("singleton_id", 1).single();
    if (error) return setError(error.message);
    const next = data as OfficeStatus;
    setStatus(next);
    if (next.updated_by) {
      const { data: p } = await supabase.from("profiles").select("full_name").eq("id", next.updated_by).single();
      setOperator(p?.full_name ?? "不明");
    } else setOperator("初期状態");
  }, [supabase]);

  useEffect(() => {
    load();
    const channel = supabase.channel("office-status-ui")
      .on("postgres_changes", { event: "*", schema: "public", table: "office_status" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, supabase]);

  async function change(next: boolean) {
    setBusy(true); setError("");
    const { error } = await supabase.rpc("set_office_state", { p_is_open: next });
    if (error) setError(error.message);
    await load(); setBusy(false);
  }

  return (
    <section className="card">
      <h2>現在のオフィス状態</h2>
      <div className={`status ${status?.is_open ? "status-open" : "status-closed"}`}>
        <span className="status-dot" />
        <strong>{status?.is_open ? "開場中" : "閉場中"}</strong>
      </div>
      {status && <p className="muted">最終更新：{formatTokyoDateTime(status.updated_at)}<br />操作：{operator}</p>}
      {error && <div className="error">{error}</div>}
      {currentUser.role === "admin" || currentUser.role === "key_manager" ? (
        <div className="actions">
          <button className="btn btn-success" disabled={busy || status?.is_open === true} onClick={() => change(true)}>開場する</button>
          <button className="btn btn-danger" disabled={busy || status?.is_open === false} onClick={() => change(false)}>閉場する</button>
        </div>
      ) : <p className="muted">開閉操作は鍵管理者または管理者のみ可能です。</p>}
    </section>
  );
}
