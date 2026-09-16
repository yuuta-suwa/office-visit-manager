import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // api/line/webhook must stay public: LINE's servers call it with no
    // Supabase session cookie, so the auth gate below would otherwise
    // redirect every webhook call to /login. Signature verification inside
    // the route itself (verifyLineSignature) is what actually authenticates
    // the caller for that one path.
    "/((?!_next/static|_next/image|favicon.ico|api/line/webhook|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
