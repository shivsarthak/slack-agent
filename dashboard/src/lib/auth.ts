import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE, verifyToken } from "@/lib/session";

/** Route-handler guard. Returns a 401 response when unauthenticated, else null. */
export async function requireAuth(): Promise<NextResponse | null> {
  const jar = await cookies();
  if (verifyToken(jar.get(SESSION_COOKIE)?.value)) return null;
  return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
}
