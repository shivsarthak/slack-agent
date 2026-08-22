"use client";

import { useState } from "react";
import { useTheme } from "next-themes";
import { AlertTriangle, LogOut, Moon, RotateCw, Sun } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiSend, useApi } from "@/lib/client";

export interface StatusPayload {
  agent: {
    running: boolean;
    pid: number | null;
    startedAt: string | null;
    restartRequired: boolean;
    strayPids: number[];
  };
  counts: { skills: number; notes: number; schedules: number; grants: number };
  recentChanges: { at: string; action: string; subject: string }[];
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Toggle theme"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  );
}

export function StatusBar() {
  const { data, refresh } = useApi<StatusPayload>("/api/status", 3000);
  const [restarting, setRestarting] = useState(false);

  async function restart() {
    setRestarting(true);
    try {
      await apiSend("/api/restart", "POST");
      toast.success("Restart signal sent. The supervisor will respawn the agent.");
    } catch (e) {
      toast.error(String(e));
    } finally {
      setRestarting(false);
      void refresh();
    }
  }

  async function logout() {
    await apiSend("/api/auth", "DELETE");
    window.location.href = "/login";
  }

  const agent = data?.agent;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3">
        <span className="relative flex size-2.5">
          {agent?.running && (
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-60" />
          )}
          <span
            className={cn(
              "relative inline-flex size-2.5 rounded-full",
              agent ? (agent.running ? "bg-success" : "bg-destructive") : "bg-muted-foreground/40",
            )}
          />
        </span>
        <div className="leading-tight">
          <span className="text-sm font-medium">
            {agent ? (agent.running ? "Agent running" : "Agent down") : "Checking status…"}
          </span>
          <span className="ml-2 text-xs text-muted-foreground">
            {agent?.running && agent.startedAt
              ? `pid ${agent.pid} · since ${new Date(agent.startedAt).toLocaleString()}`
              : agent && !agent.running
                ? "start it with scripts/run-agent.sh"
                : ""}
          </span>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={restart} disabled={restarting}>
            <RotateCw className={cn("size-3.5", restarting && "animate-spin")} />
            {restarting ? "Restarting…" : "Restart agent"}
          </Button>
          <ThemeToggle />
          <Button size="icon" variant="ghost" aria-label="Log out" onClick={logout}>
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
      {agent && agent.strayPids.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Another agent instance is running outside the supervisor</AlertTitle>
          <AlertDescription>
            <span>
              Process{agent.strayPids.length > 1 ? "es" : ""}{" "}
              {agent.strayPids.map((pid) => `pid ${pid}`).join(", ")} also connect
              {agent.strayPids.length > 1 ? "" : "s"} to the Slack app and will answer a share
              of the mentions with whatever config and code {agent.strayPids.length > 1 ? "they" : "it"} started
              with. The restart button cannot reach {agent.strayPids.length > 1 ? "them" : "it"} — stop{" "}
              {agent.strayPids.length > 1 ? "them" : "it"} in the terminal where{" "}
              {agent.strayPids.length > 1 ? "they were" : "it was"} started, or with{" "}
              <code>kill {agent.strayPids.join(" ")}</code>.
            </span>
          </AlertDescription>
        </Alert>
      )}
      {agent?.restartRequired && (
        <Alert className="border-warning/50 bg-warning/10 [&>svg]:text-warning">
          <AlertTriangle className="size-4" />
          <AlertTitle>Restart required</AlertTitle>
          <AlertDescription className="flex w-full items-center justify-between gap-4">
            <span>
              Config or the MCP registry changed since the agent started — restart to apply.
            </span>
            <Button size="sm" onClick={restart} disabled={restarting} className="shrink-0">
              Restart now
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
