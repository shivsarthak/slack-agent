"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { apiSend } from "@/lib/client";

// The config file shape as written on disk (subset the UI touches; passthrough preserved
// by always mutating a copy of the fetched object).
export type AgentConfig = Record<string, unknown> & {
  engine?: { model?: string; reasoningEffort?: string; codexPath?: string };
  bounds?: Record<string, number>;
  workspaceRetention?: { inactivityMs?: number };
  fileTransfer?: { maxDownloadBytes?: number; maxUploadBytes?: number };
  repositories?: string[];
  approvals?: {
    mode?: "off" | "coworker" | "external-writes";
    policy?: string;
    rules?: unknown[];
  };
};

export function useConfig() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    const r = await fetch("/api/config", { cache: "no-store" });
    if (r.status === 401) {
      window.location.href = "/login";
      return;
    }
    if (r.ok) setConfig((await r.json()) as AgentConfig);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (next: AgentConfig): Promise<boolean> => {
    setSaving(true);
    try {
      await apiSend("/api/config", "PUT", next);
      setConfig(next);
      toast.success("Saved. Restart the agent for the change to take effect.");
      return true;
    } catch (e) {
      toast.error(String(e));
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { config, save, saving, refresh };
}
