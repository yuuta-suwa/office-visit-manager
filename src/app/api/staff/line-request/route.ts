import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { pushMessage } from "@/lib/line/client";

// Approve or reject a staff registration request that arrived from LINE.
// Approving sends the normal Supabase invite email (the new person sets
// their own password there) and links their LINE account immediately, so
// LINE notifications/answers work before the web account is ever used.
export async function POST(req: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });

  const { data: caller } = await supabase.from("profiles").select("id,role,active").eq("id", user.id).single();
  if (!caller || !caller.active || (caller.role !== "admin" && caller.role !== "key_manager")) {
    return NextResponse.json({ error: "管理者・鍵管理者権限が必要です。" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id : "";
  const action = body?.action;
  if (!id || (action !== "approve" && action !== "reject")) {
    return NextResponse.json({ error: "id と action が必要です。" }, { status: 400 });
  }

  const service = createServiceClient();
  const { data: request } = await service
    .from("line_registration_requests")
    .select("id,line_user_id,full_name,email,status")
    .eq("id", id)
    .maybeSingle();
  if (!request) return NextResponse.json({ error: "申請が見つかりません。" }, { status: 404 });
  if (request.status !== "pending") {
    return NextResponse.json({ error: "この申請はすでに処理済みです。" }, { status: 409 });
  }

  const decision = { decided_by: caller.id, decided_at: new Date().toISOString() };

  if (action === "reject") {
    const { error } = await service
      .from("line_registration_requests")
      .update({ status: "rejected", ...decision })
      .eq("id", id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    await pushMessage(request.line_user_id, [
      { type: "text", text: "登録申請は承認されませんでした。心当たりがない場合は管理者にご確認ください。" },
    ]);
    return NextResponse.json({ ok: true });
  }

  // Refuse before inviting if this LINE account is already on some profile
  // (profiles.line_user_id is unique; failing after the email went out would
  // leave an invited account that can never be linked).
  const { data: alreadyLinked } = await service
    .from("profiles")
    .select("id")
    .eq("line_user_id", request.line_user_id)
    .maybeSingle();
  if (alreadyLinked) {
    return NextResponse.json({ error: "このLINEアカウントはすでに別のメンバーに連携されています。" }, { status: 409 });
  }

  const { data: invited, error: inviteError } = await service.auth.admin.inviteUserByEmail(request.email, {
    data: { full_name: request.full_name },
    redirectTo: `${new URL(req.url).origin}/auth/set-password`,
  });
  if (inviteError || !invited?.user) {
    return NextResponse.json(
      { error: inviteError?.message ?? "招待メールを送信できませんでした。" },
      { status: 400 }
    );
  }

  // handle_new_user() has already created the profile (role='member').
  const { error: linkError } = await service
    .from("profiles")
    .update({ line_user_id: request.line_user_id })
    .eq("id", invited.user.id);
  if (linkError) {
    return NextResponse.json(
      { error: `招待は送信しましたが、LINEの連携に失敗しました：${linkError.message}` },
      { status: 500 }
    );
  }

  const { error: approveError } = await service
    .from("line_registration_requests")
    .update({ status: "approved", ...decision })
    .eq("id", id);
  if (approveError) {
    return NextResponse.json({ error: approveError.message }, { status: 500 });
  }

  await pushMessage(request.line_user_id, [
    {
      type: "text",
      text: `「${request.full_name}」さんの登録が承認されました。イベントの通知・回答はこのLINEで行えます。\nWebアプリを使う場合は、${request.email} に届いた招待メールからパスワードを設定してください。`,
    },
  ]);

  return NextResponse.json({ ok: true });
}
