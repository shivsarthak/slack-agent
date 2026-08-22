import { readdir } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { agentStatus } from "@/lib/agent-process";
import { readJson, tailJsonl } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

async function countMd(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

export async function GET() {
  const paths = agentPaths();
  const [status, approvals, schedules, changes, skills, notes] = await Promise.all([
    agentStatus(),
    readJson<{ grants?: unknown[] }>(path.join(paths.stateDir, "approvals.json")),
    readJson<{ schedules?: unknown[] }>(path.join(paths.stateDir, "schedules.json")),
    tailJsonl(path.join(paths.stateDir, "vault-changes.jsonl"), 10),
    countMd(paths.skillsDir),
    countMd(paths.notesDir),
  ]);
  return NextResponse.json({
    agent: status,
    counts: {
      skills,
      notes,
      schedules: schedules?.schedules?.length ?? 0,
      grants: approvals?.grants?.length ?? 0,
    },
    recentChanges: changes.reverse(),
  });
}
