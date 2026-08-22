"use client";

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

const VIEWS = ["jobs", "sessions", "schedules", "occurrences", "approvals", "artifacts", "dead-letters", "audit"] as const;
type View = typeof VIEWS[number];

export default function OperationsPage() {
  const [view, setView] = useState<View>("jobs");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedTenantId, setSelectedTenantId] = useState("");
  const key = useMemo(() => view === "dead-letters" ? "deadLetters" : view === "audit" ? "events" : view, [view]);
  async function refresh() {
    let selected = selectedTenantId;
    if (!selected) {
      const current = await fetch("/api/tenants/current", { cache: "no-store" });
      const body = current.ok ? await current.json() as { tenant: { id: string } | null } : { tenant: null };
      selected = body.tenant?.id ?? "";
      setSelectedTenantId(selected);
    }
    if (!selected) { setLoading(false); return; }
    setLoading(true);
    const response = await fetch(`/api/operations/${view}?tenantId=${encodeURIComponent(selected)}`, { cache: "no-store" });
    const body = await response.json() as Record<string, Record<string, unknown>[]> & { error?: string };
    if (!response.ok) toast.error(body.error ?? "Unable to load operations");
    setRows(body[key] ?? []); setLoading(false);
  }
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(timer);
  }, [view, selectedTenantId]);
  async function mutate(url: string, body: unknown) {
    const response = await fetch(`${url}?tenantId=${encodeURIComponent(selectedTenantId)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as { error?: string };
    if (!response.ok) toast.error(result.error ?? "Operation failed"); else { toast.success("Operation recorded"); await refresh(); }
  }
  return <div className="space-y-6">
    <PageHeader title="Tenant operations" description="Tenant-scoped Jobs, Sessions, Schedules, Occurrences, approvals, artifacts, dead letters, and audit history." />
    <Tabs value={view} onValueChange={(value) => setView(value as View)}>
      <TabsList className="flex h-auto flex-wrap">{VIEWS.map((item) => <TabsTrigger key={item} value={item}>{item}</TabsTrigger>)}</TabsList>
      {VIEWS.map((item) => <TabsContent key={item} value={item}>
        <Card><CardHeader><CardTitle className="capitalize">{item}</CardTitle></CardHeader><CardContent className="space-y-3">
          {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : rows.length === 0 ? <p className="text-sm text-muted-foreground">No records.</p> : rows.map((row, index) => <div key={String(row.id ?? index)} className="rounded-md border p-4 text-sm">
            <div className="mb-2 flex items-center gap-2"><strong>{String(row.id ?? row.eventType ?? "record")}</strong>{row.status ? <Badge variant="outline">{String(row.status)}</Badge> : null}</div>
            <pre className="overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{JSON.stringify(row, null, 2)}</pre>
            {item === "approvals" && row.status === "pending" ? <div className="mt-3 flex gap-2"><Button size="sm" onClick={() => void mutate(`/api/operations/approvals/${encodeURIComponent(String(row.id))}`, { decision: "approved", idempotencyKey: crypto.randomUUID() })}>Approve</Button><Button size="sm" variant="destructive" onClick={() => void mutate(`/api/operations/approvals/${encodeURIComponent(String(row.id))}`, { decision: "denied", idempotencyKey: crypto.randomUUID() })}>Deny</Button></div> : null}
            {item === "dead-letters" ? <Button className="mt-3" size="sm" onClick={() => void mutate(`/api/operations/dead-letters/${encodeURIComponent(String(row.id))}/replay`, { reason: "dashboard operator replay", idempotencyKey: crypto.randomUUID() })}>Replay</Button> : null}
          </div>)}
        </CardContent></Card>
      </TabsContent>)}
    </Tabs>
  </div>;
}
