import { handleDashboardAuth } from "@/lib/hosted-auth";
import { cookies } from "next/headers";
import { DASHBOARD_SESSION_COOKIE, DASHBOARD_TENANT_COOKIE } from "@agent/dashboard/auth.ts";
import { dashboardAuth } from "@/lib/hosted-auth";

export const dynamic = "force-dynamic";
export const PUT = handleDashboardAuth;

export async function GET() {
  const jar = await cookies();
  const user = await dashboardAuth.authenticate(jar.get(DASHBOARD_SESSION_COOKIE)?.value);
  if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
  const tenantId = jar.get(DASHBOARD_TENANT_COOKIE)?.value;
  if (!tenantId) return Response.json({ tenant: null });
  const tenant = await dashboardAuth.authorize(user.id, tenantId, ["owner", "admin", "member"]);
  return tenant ? Response.json({ tenant }) : Response.json({ error: "forbidden" }, { status: 403 });
}
