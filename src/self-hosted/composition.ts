import { composeHostedTenant, type HostedTenantComposition } from "../hosted/composition.ts";
import type { CoworkerDeps } from "../coworker.ts";
import { tenantId } from "../tenant.ts";

/** A self-hosted process has one Slack workspace, which is its one Tenant. */
export function composeSelfHosted(input: {
  workspaceId: string;
  deps: Omit<CoworkerDeps, "tenant">;
}): HostedTenantComposition {
  return composeHostedTenant({
    tenant: { id: tenantId(input.workspaceId) },
    deps: input.deps,
  });
}
