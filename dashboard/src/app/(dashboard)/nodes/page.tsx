"use client";

import { useState } from "react";
import ReactMarkdown from "react-markdown";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/client";

interface NoteMeta {
  name: string;
  modifiedAt: string;
  bytes: number;
}
interface Change {
  at: string;
  action: string;
  subject: string;
  thread?: string;
  job?: string;
  diff?: string;
}
interface Schedule {
  id?: number | string;
  name?: string;
  cron?: string;
  calendar?: string;
  prompt?: string;
  channel?: string;
  [k: string]: unknown;
}

export default function NodesPage() {
  const { data: notes } = useApi<{ notes: NoteMeta[] }>("/api/notes", 10000);
  const { data: changes } = useApi<{ changes: Change[] }>("/api/changes?n=100", 5000);
  const { data: schedules } = useApi<{ schedules: Schedule[]; occurrences: unknown[] }>(
    "/api/schedules",
    10000,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [expanded, setExpanded] = useState<number | null>(null);

  async function open(name: string) {
    const r = await fetch(`/api/notes?name=${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!r.ok) return;
    const j = await r.json();
    setSelected(name);
    setContent(j.content);
  }

  return (
    <div className="space-y-8">
      <PageHeader
        title="Nodes"
        description="What the agent creates: vault Notes (its memory), the change audit trail, and schedules. All read-only — the vault Notes belong to the agent."
      />
      <Tabs defaultValue="notes">
        <TabsList>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="changes">Change log</TabsTrigger>
          <TabsTrigger value="schedules">Schedules</TabsTrigger>
        </TabsList>
        <TabsContent value="notes">
          <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
            <Card>
              <CardHeader>
                <CardTitle>Vault notes</CardTitle>
              </CardHeader>
              <CardContent>
                <ul className="space-y-1">
                  {(notes?.notes ?? []).map((n) => (
                    <li key={n.name}>
                      <button
                        onClick={() => open(n.name)}
                        className={`w-full rounded-md px-3 py-2 text-left text-sm hover:bg-accent ${selected === n.name ? "bg-accent" : ""}`}
                      >
                        {n.name}
                        <span className="block text-xs text-muted-foreground">
                          {new Date(n.modifiedAt).toLocaleString()}
                        </span>
                      </button>
                    </li>
                  ))}
                  {notes && notes.notes.length === 0 && (
                    <li className="text-sm text-muted-foreground">No notes yet.</li>
                  )}
                </ul>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{selected ?? "Preview"}</CardTitle>
              </CardHeader>
              <CardContent>
                {selected ? (
                  <article className="prose prose-sm dark:prose-invert max-w-none [&_pre]:overflow-x-auto">
                    <ReactMarkdown>
                      {content.replace(/^---\n[\s\S]*?\n---\n/, "")}
                    </ReactMarkdown>
                  </article>
                ) : (
                  <p className="text-sm text-muted-foreground">Select a note.</p>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
        <TabsContent value="changes">
          <Card>
            <CardContent className="pt-6">
              {changes?.changes.length ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Subject</TableHead>
                      <TableHead>Job</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changes.changes.map((c, i) => (
                      <TableRow
                        key={i}
                        className="cursor-pointer"
                        onClick={() => setExpanded(expanded === i ? null : i)}
                      >
                        <TableCell className="whitespace-nowrap text-muted-foreground">
                          {new Date(c.at).toLocaleString()}
                        </TableCell>
                        <TableCell>{c.action}</TableCell>
                        <TableCell>
                          {c.subject}
                          {expanded === i && c.diff && (
                            <pre className="mt-2 max-h-64 overflow-auto rounded bg-muted p-2 text-xs">
                              {c.diff}
                            </pre>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{c.job ?? ""}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <p className="text-sm text-muted-foreground">No changes recorded.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
        <TabsContent value="schedules">
          <Card>
            <CardContent className="pt-6">
              {schedules?.schedules.length ? (
                <pre className="max-h-[480px] overflow-auto rounded bg-muted p-4 text-xs">
                  {JSON.stringify(schedules.schedules, null, 2)}
                </pre>
              ) : (
                <p className="text-sm text-muted-foreground">No schedules.</p>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
