"use client";

import { useCallback, useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { formatTokyoDateTime } from "@/lib/date";
import type { OpenCloseLog, Profile } from "@/lib/types";

type Row = OpenCloseLog & { name?: string };

export default function OpenCloseLogs() {
  const supabase = createClient();
  const [rows, setRows] = useState<Row[]>([]);

  const load = useCallback(async () => {
    const { data } = await supabase.from("open_close_logs").select("*").order("created_at", { ascending:false }).limit(20);
    const logs = (data ?? []) as OpenCloseLog[];
    const ids = [...new Set(logs.map(x => x.performed_by))];
    let names = new Map<string,string>();
    if (ids.length) {
      const { data: profiles } = await supabase.from("profiles").select("id,full_name").in("id", ids);
      names = new Map((profiles as Pick<Profile,"id"|"full_name">[] | null)?.map(p => [p.id,p.full_name]) ?? []);
    }
    setRows(logs.map(x => ({...x, name:names.get(x.performed_by) ?? "不明"})));
  }, [supabase]);

  useEffect(() => {
    load();
    const channel = supabase.channel("open-close-logs-ui")
      .on("postgres_changes", { event:"INSERT", schema:"public", table:"open_close_logs" }, load)
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [load, supabase]);

  return <section className="card"><h2>開場・閉場ログ</h2>
    {!rows.length ? <p className="muted">ログはありません。</p> : <div className="table-wrap"><table><thead><tr><th>日時</th><th>操作</th><th>担当者</th></tr></thead><tbody>{rows.map(r => <tr key={r.id}><td>{formatTokyoDateTime(r.created_at)}</td><td><strong>{r.action === "open" ? "開場" : "閉場"}</strong></td><td>{r.name}</td></tr>)}</tbody></table></div>}
  </section>;
}
