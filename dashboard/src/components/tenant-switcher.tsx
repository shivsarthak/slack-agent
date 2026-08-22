"use client";

import { useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface Tenant { id: string; name: string; role: "owner" | "admin" | "member" }

export function TenantSwitcher() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [current, setCurrent] = useState("");
  useEffect(() => {
    void fetch("/api/tenants", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const body = await response.json() as { tenants: Tenant[] };
      setTenants(body.tenants);
      const currentResponse = await fetch("/api/tenants/current", { cache: "no-store" });
      const selected = currentResponse.ok ? (await currentResponse.json() as { tenant: Tenant | null }).tenant : null;
      const fallback = body.tenants[0]?.id ?? "";
      setCurrent(selected?.id ?? fallback);
      if (!selected && fallback) await switchTenant(fallback);
    });
  }, []);
  async function switchTenant(tenantId: string) {
    const response = await fetch("/api/tenants/current", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ tenantId }) });
    if (response.ok) window.location.reload();
  }
  if (!tenants.length) return null;
  return (
    <Select value={current} onValueChange={(value) => void switchTenant(value)}>
      <SelectTrigger className="w-56" aria-label="Tenant"><SelectValue placeholder="Select Tenant" /></SelectTrigger>
      <SelectContent>{tenants.map((tenant) => <SelectItem key={tenant.id} value={tenant.id}>{tenant.name} · {tenant.role}</SelectItem>)}</SelectContent>
    </Select>
  );
}
