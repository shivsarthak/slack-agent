"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { useConfig, type AgentConfig } from "@/lib/config-client";

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh"];
const BOUND_FIELDS: { key: string; label: string }[] = [
  { key: "turnTimeoutMs", label: "Turn timeout (ms)" },
  { key: "maxTurnsPerJob", label: "Max turns per job" },
  { key: "tokenBudgetPerJob", label: "Token budget per job" },
  { key: "maxConcurrentJobs", label: "Max concurrent jobs" },
  { key: "librarianTimeoutMs", label: "Librarian timeout (ms)" },
];

export default function SettingsPage() {
  const { config, save, saving } = useConfig();
  const [draft, setDraft] = useState<AgentConfig | null>(null);
  const [rawDraft, setRawDraft] = useState("");

  useEffect(() => {
    if (config && !draft) {
      setDraft(structuredClone(config));
      setRawDraft(JSON.stringify(config, null, 2));
    }
  }, [config, draft]);

  if (!draft) return <p className="text-sm text-muted-foreground">Loading configuration…</p>;

  const engine = draft.engine ?? {};
  const bounds = draft.bounds ?? {};

  function setNum(section: "bounds" | "fileTransfer" | "workspaceRetention", key: string, v: string) {
    setDraft((d) => {
      if (!d) return d;
      const next = structuredClone(d);
      const sec = { ...(next[section] as Record<string, number> | undefined) };
      if (v === "") delete sec[key];
      else sec[key] = Number(v);
      next[section] = sec;
      return next;
    });
  }

  async function saveForm() {
    if (!draft) return;
    if (await save(draft)) setRawDraft(JSON.stringify(draft, null, 2));
  }

  async function saveRaw() {
    let parsed: AgentConfig;
    try {
      parsed = JSON.parse(rawDraft);
    } catch (e) {
      toast.error(`Invalid JSON: ${e}`);
      return;
    }
    if (await save(parsed)) setDraft(structuredClone(parsed));
  }

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Settings"
        description="Edits are validated against the agent's own schema, then written to open-agent.config.json. The agent reads this file at startup, so changes need a restart."
      />
      <Tabs defaultValue="form">
        <TabsList>
          <TabsTrigger value="form">Form</TabsTrigger>
          <TabsTrigger value="raw">Raw JSON</TabsTrigger>
        </TabsList>
        <TabsContent value="form" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Engine</CardTitle>
              <CardDescription>Model and reasoning effort for the Codex engine.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>Model</Label>
                <Input
                  value={engine.model ?? ""}
                  onChange={(e) =>
                    setDraft({ ...draft, engine: { ...engine, model: e.target.value || undefined } })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Reasoning effort</Label>
                <Select
                  value={engine.reasoningEffort ?? ""}
                  onValueChange={(v) =>
                    setDraft({ ...draft, engine: { ...engine, reasoningEffort: v } })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="default" />
                  </SelectTrigger>
                  <SelectContent>
                    {EFFORTS.map((e) => (
                      <SelectItem key={e} value={e}>
                        {e}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Bounds</CardTitle>
              <CardDescription>Per-job limits and instance-wide concurrency.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              {BOUND_FIELDS.map((f) => (
                <div key={f.key} className="space-y-2">
                  <Label>{f.label}</Label>
                  <Input
                    type="number"
                    value={bounds[f.key] ?? ""}
                    onChange={(e) => setNum("bounds", f.key, e.target.value)}
                  />
                </div>
              ))}
              <div className="space-y-2">
                <Label>Workspace inactivity retention (ms)</Label>
                <Input
                  type="number"
                  value={draft.workspaceRetention?.inactivityMs ?? ""}
                  onChange={(e) => setNum("workspaceRetention", "inactivityMs", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max download bytes</Label>
                <Input
                  type="number"
                  value={draft.fileTransfer?.maxDownloadBytes ?? ""}
                  onChange={(e) => setNum("fileTransfer", "maxDownloadBytes", e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Max upload bytes</Label>
                <Input
                  type="number"
                  value={draft.fileTransfer?.maxUploadBytes ?? ""}
                  onChange={(e) => setNum("fileTransfer", "maxUploadBytes", e.target.value)}
                />
              </div>
            </CardContent>
          </Card>
          <Button onClick={saveForm} disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
        </TabsContent>
        <TabsContent value="raw" className="space-y-4">
          <Textarea
            className="min-h-[420px] font-mono text-xs"
            value={rawDraft}
            onChange={(e) => setRawDraft(e.target.value)}
          />
          <Button onClick={saveRaw} disabled={saving}>
            {saving ? "Saving…" : "Save raw config"}
          </Button>
        </TabsContent>
      </Tabs>
    </div>
  );
}
