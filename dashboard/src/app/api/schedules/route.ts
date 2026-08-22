import path from "node:path";
import { NextResponse } from "next/server";
import { readJson } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const data = await readJson(path.join(agentPaths().stateDir, "schedules.json"));
  return NextResponse.json(data ?? { schedules: [], occurrences: [] });
}
