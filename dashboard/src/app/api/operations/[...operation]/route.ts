import { NextRequest } from "next/server";
import { authorizeTenantRequest, type TenantRole } from "@agent/dashboard/auth.ts";
import { createTenantOperationsHttpHandler } from "@agent/dashboard/operations.ts";
import { dashboardAuth, dashboardPool } from "@/lib/hosted-auth";

export const dynamic = "force-dynamic";

const handle = createTenantOperationsHttpHandler({
  pool: dashboardPool,
  async authorize(request, tenantId, allowed: readonly TenantRole[]) {
    const access = await authorizeTenantRequest(dashboardAuth, request, tenantId, allowed);
    return access instanceof Response
      ? undefined
      : { userId: access.user.id, tenantId: access.tenant.id, role: access.tenant.role };
  },
});

export async function GET(request: NextRequest) { return handle(request); }
export async function POST(request: NextRequest) { return handle(request); }
