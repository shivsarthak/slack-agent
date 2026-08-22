/** Stable identity for the customer boundary that owns every domain operation. */
export type TenantId = string & { readonly __tenantId: unique symbol };

export interface Tenant {
  readonly id: TenantId;
}

/** Validate identity at an adapter boundary before it enters the domain. */
export function tenantId(value: string): TenantId {
  const id = value.trim();
  if (id.length === 0) throw new Error("Tenant identity must not be empty");
  return id as TenantId;
}
