import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import Dashboard from "@/components/Dashboard";
import type { Profile } from "@/lib/types";

export default async function HomePage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: profile } = await supabase
    .from("profiles")
    .select("id, full_name, role, active, team, jurisdiction")
    .eq("id", user.id)
    .single();

  if (!profile || !profile.active) {
    return <main className="shell"><div className="card">プロフィールがありません。schema.sql が適用済みか確認してください。</div></main>;
  }

  return <Dashboard currentUser={profile as Profile} email={user.email ?? ""} />;
}
