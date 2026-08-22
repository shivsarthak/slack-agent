"use client";

import { useState } from "react";
import { toast } from "sonner";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { apiSend, useApi } from "@/lib/client";

interface SkillMeta {
  name: string;
  modifiedAt: string;
  bytes: number;
}

export default function SkillsPage() {
  const { data, refresh } = useApi<{ skills: SkillMeta[]; missingDir?: boolean }>("/api/skills", 10000);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function open(name: string) {
    const r = await fetch(`/api/skills/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!r.ok) return toast.error("Failed to load skill");
    const j = await r.json();
    setSelected(name);
    setContent(j.content);
  }

  async function saveSkill() {
    if (!selected) return;
    setBusy(true);
    try {
      await apiSend(`/api/skills/${encodeURIComponent(selected)}`, "PUT", { content });
      toast.success("Skill saved — applies to the next job.");
      void refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSkill() {
    if (!selected || !window.confirm(`Delete skill "${selected}"?`)) return;
    setBusy(true);
    try {
      await apiSend(`/api/skills/${encodeURIComponent(selected)}`, "DELETE");
      toast.success("Skill deleted.");
      setSelected(null);
      void refresh();
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function createSkill() {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      const created = await apiSend<{ name: string }>("/api/skills", "POST", {
        name,
        content: `# ${name.replace(/\.md$/, "")}\n\n`,
      });
      toast.success("Skill created.");
      setNewName("");
      void refresh();
      void open(created.name);
    } catch (e) {
      toast.error(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Skills"
        description="Human-authored markdown procedures in the vault's Skills directory. The agent reads them per job and can never write them — this editor is the write path."
      />
      {data?.missingDir && (
        <p className="text-sm text-amber-600">
          The Skills directory does not exist yet — creating a first skill will fail until it is
          created on disk.
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>All skills</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-2">
              <Input
                placeholder="New skill name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createSkill()}
              />
              <Button size="sm" onClick={createSkill} disabled={busy}>
                Add
              </Button>
            </div>
            <ul className="space-y-1">
              {(data?.skills ?? []).map((s) => (
                <li key={s.name}>
                  <button
                    onClick={() => open(s.name)}
                    className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${selected === s.name ? "bg-accent" : ""}`}
                  >
                    {s.name}
                    <span className="block text-xs text-muted-foreground">
                      {new Date(s.modifiedAt).toLocaleString()}
                    </span>
                  </button>
                </li>
              ))}
              {data && data.skills.length === 0 && (
                <li className="text-sm text-muted-foreground">No skills yet.</li>
              )}
            </ul>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{selected ?? "Editor"}</CardTitle>
            <CardDescription>
              {selected ? "Markdown with optional frontmatter." : "Select or create a skill."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {selected ? (
              <>
                <Textarea
                  className="min-h-[420px] font-mono text-xs"
                  value={content}
                  onChange={(e) => setContent(e.target.value)}
                />
                <div className="flex gap-2">
                  <Button onClick={saveSkill} disabled={busy}>
                    {busy ? "Working…" : "Save skill"}
                  </Button>
                  <Button variant="destructive" onClick={deleteSkill} disabled={busy}>
                    Delete
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing selected.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
