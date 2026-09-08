"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/types";
import OfficeStatusCard from "./OfficeStatusCard";
import TodayVisitors from "./TodayVisitors";
import ReservationManager from "./ReservationManager";
import OpenCloseLogs from "./OpenCloseLogs";
import UserManagement from "./UserManagement";
import EventManager from "./EventManager";

export default function Dashboard({ currentUser, email }: { currentUser: Profile; email: string }) {
  const [section, setSection] = useState<"main" | "users">("main");
  const router = useRouter();
  const isAdmin = currentUser.role === "admin";

  async function signOut() {
    await createClient().auth.signOut();
    router.replace("/login"); router.refresh();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand"><h1>来社管理</h1><p>開閉状況・来社予約をリアルタイム共有</p></div>
        <div className="userbox">
          <span><strong>{currentUser.full_name}</strong> <span className="muted">{email}</span></span>
          <span className="badge">{currentUser.role === "admin" ? "管理者" : currentUser.role === "key_manager" ? "鍵管理者" : "メンバー"}</span>
          {isAdmin && <button className="btn" onClick={() => setSection(section === "main" ? "users" : "main")}>{section === "main" ? "メンバー管理" : "ダッシュボード"}</button>}
          <button className="btn" onClick={signOut}>ログアウト</button>
        </div>
      </header>

      {section === "users" && isAdmin ? (
        <UserManagement currentUserId={currentUser.id} />
      ) : (
        <div className="grid">
          <div className="col-4"><OfficeStatusCard currentUser={currentUser} /></div>
          <div className="col-8"><TodayVisitors /></div>
          <div className="col-6"><ReservationManager currentUser={currentUser} /></div>
          <div className="col-6"><OpenCloseLogs /></div>
          <div className="col-12"><EventManager currentUser={currentUser} /></div>
        </div>
      )}
    </main>
  );
}
