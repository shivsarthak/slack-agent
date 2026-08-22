"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { apiSend, useApi } from "@/lib/client";

export default function PromptsPage() {
  const { data, refresh } = useApi<{ content: string; maxBytes: number }>("/api/manual");
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && draft === null) setDraft(data.content);
  }, [data, draft]);

  const bytes = draft ? new TextEncoder().encode(draft).length : 0;
  const max = data?.maxBytes ?? 32768;

  async function saveManual() {
    if (draft === null) return;
    setSaving(true);
    try {
      await apiSend("/api/manual", "PUT", { content: draft });
      toast.success("Operating manual saved — applies to the next job, no restart needed.");
      void refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader
        title="Prompts"
        description="The operating manual is copied into every job workspace as AGENTS.md — the agent's editable persona/system prompt. It is re-read per job, so saves apply immediately without a restart."
      />
      {draft === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <Textarea
            className="min-h-[480px] font-mono text-xs"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex items-center gap-4">
            <Button onClick={saveManual} disabled={saving || bytes > max}>
              {saving ? "Saving…" : "Save operating manual"}
            </Button>
            <span className={`text-xs ${bytes > max ? "text-destructive" : "text-muted-foreground"}`}>
              {bytes.toLocaleString()} / {max.toLocaleString()} bytes
            </span>
          </div>
        </>
      )}
    </div>
  );
}
