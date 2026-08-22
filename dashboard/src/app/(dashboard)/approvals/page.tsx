"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useApi } from "@/lib/client";
import { useConfig } from "@/lib/config-client";

interface Grant {
  threadKey: string;
  key: string;
  approvedBy: string;
  createdAt: number;
  sourceRequest: string;
}

const MODES = [
  { value: "off", hint: "No gate — everything is allowed." },
  { value: "coworker", hint: "Workspace-confined work is automatic; boundaries ask." },
  { value: "external-writes", hint: "Any external mutation asks for approval." },
] as const;

export default function ApprovalsPage() {
  const { config, save, saving } = useConfig();
  const { data: grants } = useApi<{ grants: Grant[] }>("/api/approvals", 5000);
  const [mode, setMode] = useState<string>("");
  const [policy, setPolicy] = useState("");
  const [rules, setRules] = useState("[]");

  useEffect(() => {
    if (config && mode === "") {
      setMode(config.approvals?.mode ?? "coworker");
      setPolicy(config.approvals?.policy ?? "");
      setRules(JSON.stringify(config.approvals?.rules ?? [], null, 2));
    }
  }, [config, mode]);

  async function saveApprovals() {
    if (!config) return;
    let parsedRules: unknown[];
    try {
      parsedRules = JSON.parse(rules);
    } catch (e) {
      toast.error(`Rules are not valid JSON: ${e}`);
      return;
    }
    const next = structuredClone(config);
    next.approvals = {
      mode: mode as "off" | "coworker" | "external-writes",
      ...(policy.trim() ? { policy: policy.trim() } : {}),
      rules: parsedRules,
    };
    await save(next);
  }

  return (
    <div className="max-w-3xl space-y-8">
      <PageHeader
        title="Approvals"
        description="The goal-aware approval gate has no numeric threshold — it is a mode, an optional natural-language policy evaluated by an isolated reviewer, and explicit allow/ask/deny rules. Changes require an agent restart."
      />
      <Card>
        <CardHeader>
          <CardTitle>Gate configuration</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Mode</Label>
            <Select value={mode} onValueChange={setMode}>
              <SelectTrigger>
                <SelectValue placeholder="mode" />
              </SelectTrigger>
              <SelectContent>
                {MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {m.value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {MODES.find((m) => m.value === mode)?.hint}
            </p>
          </div>
          <div className="space-y-2">
            <Label>Policy (natural language, evaluated by the LLM reviewer)</Label>
            <Textarea
              className="min-h-[120px]"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              placeholder="e.g. Changes confined to the Job workspace are automatic; external mutations require approval."
            />
          </div>
          <div className="space-y-2">
            <Label>Rules (JSON array of allow/ask/deny rules)</Label>
            <Textarea
              className="min-h-[120px] font-mono text-xs"
              value={rules}
              onChange={(e) => setRules(e.target.value)}
            />
          </div>
          <Button onClick={saveApprovals} disabled={saving || !config}>
            {saving ? "Saving…" : "Save approval settings"}
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Active thread grants</CardTitle>
          <CardDescription>
            &quot;Allow similar in this Thread&quot; grants recorded by the agent (read-only).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {grants?.grants.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Thread</TableHead>
                  <TableHead>Approved by</TableHead>
                  <TableHead>When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.grants.map((g) => (
                  <TableRow key={g.key}>
                    <TableCell className="font-mono text-xs">{g.threadKey}</TableCell>
                    <TableCell>{g.approvedBy}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {new Date(g.createdAt).toLocaleString()}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No active grants.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
