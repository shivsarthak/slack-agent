"use client";

import Link from "next/link";
import { CalendarClock, FileText, ShieldCheck, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useApi } from "@/lib/client";
import type { StatusPayload } from "@/components/status-bar";

const CARDS = [
  { key: "skills", label: "Skills", href: "/skills", icon: Sparkles, hint: "procedures the agent follows" },
  { key: "notes", label: "Vault notes", href: "/nodes", icon: FileText, hint: "the agent's memory" },
  { key: "schedules", label: "Schedules", href: "/nodes", icon: CalendarClock, hint: "recurring tasks" },
  { key: "grants", label: "Thread grants", href: "/approvals", icon: ShieldCheck, hint: "active approvals" },
] as const;

export default function OverviewPage() {
  const { data } = useApi<StatusPayload>("/api/status", 5000);
  return (
    <div className="space-y-8">
      <PageHeader
        title="Overview"
        description="A live view of the agent's state — its skills, memory, schedules, and approvals."
      />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {CARDS.map(({ key, label, href, icon: Icon, hint }) => (
          <Link key={key} href={href} className="group">
            <Card className="h-full gap-2 py-5 transition-all group-hover:-translate-y-0.5 group-hover:shadow-md">
              <CardHeader className="pb-0">
                <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
                  {label}
                  <Icon className="size-4 text-primary/70" />
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data ? (
                  <div className="text-3xl font-semibold tracking-tight">{data.counts[key]}</div>
                ) : (
                  <Skeleton className="h-9 w-12" />
                )}
                <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Recent vault activity</CardTitle>
          <CardDescription>The latest entries from the vault change log.</CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <div className="space-y-2">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-9 w-full" />
              ))}
            </div>
          ) : data.recentChanges.length ? (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-44">When</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Subject</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.recentChanges.map((c, i) => (
                  <TableRow key={i}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {new Date(c.at).toLocaleString()}
                    </TableCell>
                    <TableCell>{c.action}</TableCell>
                    <TableCell className="font-medium">{c.subject}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <p className="text-sm text-muted-foreground">No vault changes recorded yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
