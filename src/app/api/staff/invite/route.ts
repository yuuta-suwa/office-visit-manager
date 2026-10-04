import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const { data: profile } = await supabase.from("profiles").select("id,role,active").eq("id", user.id).single();
  if (!profile || !profile.active || (profile.role !== "admin" && profile.role !== "key_manager")) {
    return NextResponse.json({ error: "管理者・鍵管理者権限が必要です。" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim() : "";
  const fullName = typeof body?.full_name === "string" ? body.full_name.trim().slice(0, 200) : "";
  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: "有効なメールアドレスを入力してください。" }, { status: 400 });
  }

  // Account creation itself needs the service role (auth.admin API); the
  // new profiles row is created automatically by handle_new_user(), which
  // always assigns role='member' regardless of any metadata sent here --
  // an invited staff member is never created as key_manager/admin.
  const service = createServiceClient();
  // The link in the email must come back to this app's set-password page,
  // not whatever Site URL the Supabase project happens to be configured
  // with. The URL also has to be on the project's Redirect URLs allowlist,
  // otherwise Supabase silently falls back to the Site URL.
  const { error } = await service.auth.admin.inviteUserByEmail(email, {
    data: fullName ? { full_name: fullName } : undefined,
    redirectTo: `${new URL(req.url).origin}/auth/set-password`,
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
