import { createClient as createSupabaseClient } from "@supabase/supabase-js";

// Service-role client: bypasses RLS and the EXECUTE grants on
// record_event_response_via_service. Only import this from server-side
// code (Route Handlers) that has no end-user session to act on (the LINE
// webhook) -- never from a "use client" component. SUPABASE_SERVICE_ROLE_KEY
// has no NEXT_PUBLIC_ prefix, so Next.js never inlines it into client bundles.
export function createServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  }
  return createSupabaseClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
