"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";

type AuditRow = {
  id: string;
  reservation_id: string;
  changed_by: string;
  old_values: Record<string, unknown>;
  new_values: Record<string, unknown>;
  reason: string;
  changed_at: string;
};

function describe(row: AuditRow) {
  const status = row.new_values.status as string | undefined;
  return status === "cancelled" ? "キャンセル" : "変更";
}

function timeRange(row: AuditRow) {
  const date = (row.new_values.visit_date as string | undefined) ?? (row.old_values.visit_date as string | undefined);
  const start = (row.new_values.start_time as string | undefined) ?? (row.old_values.start_time as string | undefined);
  const end = (row.new_values.end_time as string | undefined) ?? (row.old_values.end_time as string | undefined);
  if (!date || !start || !end) return "";
  return `${date}　${start.slice(0, 5)}–${end.slice(0, 5)}`;
}

export default function ReservationHistoryAdmin({ currentUser }: { currentUser: Profile }) {
  const supabase = createClient();
  const canView = currentUser.role === "admin" || currentUser.role === "key_manager";
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (!canView) return;
    setError("");

    const { data, error } = await supabase
      .from("reservation_audit_logs")
      .select("id,reservation_id,changed_by,old_values,new_values,reason,changed_at")
      .order("changed_at", { ascending: false })
      .limit(100);

    if (error) { setError(error.message); return; }

    const auditRows = (data ?? []) as AuditRow[];
    setRows(auditRows);

    const ids = Array.from(new Set(auditRows.map((row) => row.changed_by)));
    if (ids.length) {
      const { data: profileData } = await supabase.from("profiles").select("id,full_name").in("id", ids);
      setNames(
        Object.fromEntries(
          ((profileData ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name])
        )
      );
    }
  }, [canView, supabase]);

  useEffect(() => { load(); }, [load]);

  if (!canView) return null;

  return (
    <section className="card">
      <div className="section-head">
        <h2>予約変更履歴</h2>
        <span className="badge">直近{rows.length}件</span>
      </div>

      {error && <div className="error">{error}</div>}

      {!rows.length ? (
        <p className="muted">履歴はありません。</p>
      ) : (
        <div className="list">
          {rows.map((row) => (
            <div className="row" key={row.id}>
              <div className="row-main">
                <div className="row-title">
                  {names[row.changed_by] ?? "不明なユーザー"}　{describe(row)}
                </div>
                <div className="row-note">
                  {timeRange(row)}
                  {timeRange(row) ? "　" : ""}
                  {new Date(row.changed_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })}
                  {row.reason ? `　理由：${row.reason}` : ""}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
