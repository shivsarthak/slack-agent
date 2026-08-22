"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useConfig } from "@/lib/config-client";

export default function RepositoriesPage() {
  const { config, save, saving } = useConfig();
  const [name, setName] = useState("");
  const repos = config?.repositories ?? [];

  async function add() {
    if (!config) return;
    const trimmed = name.trim();
    if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
      toast.error("Expected owner/repository");
      return;
    }
    if (repos.includes(trimmed)) {
      toast.error("Already configured");
      return;
    }
    const next = structuredClone(config);
    next.repositories = [...repos, trimmed];
    if (await save(next)) setName("");
  }

  async function remove(repo: string) {
    if (!config) return;
    const next = structuredClone(config);
    next.repositories = repos.filter((r) => r !== repo);
    await save(next);
  }

  return (
    <div className="max-w-2xl space-y-8">
      <PageHeader
        title="Repositories"
        description="GitHub repositories the agent may check out, lazily and per-thread."
      />
      <Card>
        <CardHeader>
          <CardTitle>GitHub repositories</CardTitle>
          <CardDescription>
            Repositories the agent may check out (lazy, per-thread). Requires the github MCP
            connector; changes take effect after a restart.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="owner/repository"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <Button onClick={add} disabled={saving || !config}>
              Add
            </Button>
          </div>
          {repos.length === 0 ? (
            <p className="text-sm text-muted-foreground">No repositories configured.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {repos.map((r) => (
                <li key={r} className="flex items-center justify-between px-4 py-2">
                  <span className="font-mono text-sm">{r}</span>
                  <Button size="sm" variant="ghost" onClick={() => remove(r)} disabled={saving}>
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
