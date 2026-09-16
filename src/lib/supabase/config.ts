// Never include configuration values in error messages.
export function getSupabaseConfigError(
  url = process.env.NEXT_PUBLIC_SUPABASE_URL,
  key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
): string | null {
  try {
    const parsed = new URL(url ?? "");
    if (!['http:', 'https:'].includes(parsed.protocol) || /\s/.test(url ?? '') || parsed.username || parsed.password) throw new Error();
  } catch {
    return "Supabase Project URLが未設定、または形式が不正です。.env.localのNEXT_PUBLIC_SUPABASE_URLを確認してください。";
  }
  if (!key?.trim()) return "Supabase公開キーが未設定です。.env.localを確認してください。";
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key) && !/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    return "Supabase公開キーの形式が不正です。.env.localのNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEYを確認してください。";
  }
  return null;
}
