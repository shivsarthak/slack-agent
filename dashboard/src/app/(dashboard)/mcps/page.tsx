"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { apiSend } from "@/lib/client";

type McpFile = {
  $schema?: string;
  mcpServers: Record<string, Record<string, unknown> & { type?: string; enabled?: boolean }>;
};

export default function McpsPage() {
  const [file, setFile] = useState<McpFile | null>(null);
  const [raw, setRaw] = useState("");
  const [saving, setSaving] = useState(false);

  async function load() {
    const r = await fetch("/api/mcp", { cache: "no-store" });
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (r.ok) {
      const j = (await r.json()) as McpFile;
      setFile(j);
      setRaw(JSON.stringify(j, null, 2));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function persist(next: McpFile) {
    setSaving(true);
    try {
      await apiSend("/api/mcp", "PUT", next);
      setFile(next);
      setRaw(JSON.stringify(next, null, 2));
      toast.success("MCP registry saved. Restart the agent to apply.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggle(name: string, enabled: boolean) {
    if (!file) return;
    const next = structuredClone(file);
    next.mcpServers[name] = { ...next.mcpServers[name], enabled };
    await persist(next);
  }

  async function saveRaw() {
    let parsed: McpFile;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      toast.error(`Invalid JSON: ${e}`);
      return;
    }
    await persist(parsed);
  }

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="MCPs"
        description="Connectors from mcp.json — the single MCP registry. Credentials stay in .env; the file only names environment variables. Changes require an agent restart."
      />
      <Tabs defaultValue="servers">
        <TabsList>
          <TabsTrigger value="servers">Servers</TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="servers" className="space-y-4">
          {file ? (
            Object.entries(file.mcpServers).map(([name, server]) => (
              <Card key={name}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      {name}
                      <Badge variant="outline">{String(server.type ?? "?")}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {String(server.url ?? server.command ?? "")}
                    </CardDescription>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">
                      {server.enabled === false ? "disabled" : "enabled"}
                    </span>
                    <Switch
                      checked={server.enabled !== false}
                      onCheckedChange={(v) => toggle(name, v)}
                      disabled={saving}
                    />
                  </div>
                </CardHeader>
              </Card>
            ))
          ) : (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          <p className="text-xs text-muted-foreground">
            To add or edit a server, use the Raw JSON tab — the full schema (transports, headers,
            timeouts, disabled tools) is validated on save.
          </p>
        </TabsContent>
        <TabsContent value="raw" className="space-y-4">
          <Textarea
            className="min-h-[420px] font-mono text-xs"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
          />
          <Button onClick={saveRaw} disabled={saving}>
            {saving ? "Saving…" : "Save registry"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
