import { NextRequest, NextResponse } from "next/server";
import {
  authorizeTenantRequest,
  DASHBOARD_SESSION_COOKIE,
  DASHBOARD_TENANT_COOKIE,
} from "@agent/dashboard/auth.ts";
import { dashboardAuth } from "@/lib/hosted-auth";

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(DASHBOARD_SESSION_COOKIE)?.value;
  const user = await dashboardAuth.authenticate(token);
  if (user) {
    if (request.nextUrl.pathname.startsWith("/api/tenants"))
      return NextResponse.next();
    const tenantId = request.cookies.get(DASHBOARD_TENANT_COOKIE)?.value;
    if (tenantId) {
      const mutation =
        request.nextUrl.pathname.startsWith("/api/") &&
        !["GET", "HEAD", "OPTIONS"].includes(request.method);
      const access = await authorizeTenantRequest(
        dashboardAuth,
        request,
        tenantId,
        mutation ? ["owner", "admin"] : ["owner", "admin", "member"],
      );
      if (!(access instanceof Response)) return NextResponse.next();
      return access;
    }
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "tenant required" }, { status: 403 });
    }
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  }
  const login = request.nextUrl.clone();
  login.pathname = "/login";
  login.search = "";
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!login|api/auth|_next|favicon.ico).*)"],
};
