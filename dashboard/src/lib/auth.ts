import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { DASHBOARD_SESSION_COOKIE } from "@agent/dashboard/auth.ts";
import { dashboardAuth } from "@/lib/hosted-auth";

/** Route-handler guard. Returns a 401 response when unauthenticated, else null. */
export async function requireAuth(): Promise<NextResponse | null> {
  const jar = await cookies();
  if (
    await dashboardAuth.authenticate(jar.get(DASHBOARD_SESSION_COOKIE)?.value)
  )
    return null;
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
