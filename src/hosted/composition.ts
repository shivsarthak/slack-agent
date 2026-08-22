import { createCoworker, type Coworker, type CoworkerDeps } from "../coworker.ts";
import type { Tenant } from "../tenant.ts";

export interface HostedTenantComposition {
  tenant: Tenant;
  coworker: Coworker;
}

/** Hosted adapters must resolve a Tenant before constructing domain operations. */
export function composeHostedTenant(input: {
  tenant: Tenant;
  deps: Omit<CoworkerDeps, "tenant">;
}): HostedTenantComposition {
  return {
    tenant: input.tenant,
    coworker: createCoworker({ ...input.deps, tenant: input.tenant }),
  };
}
