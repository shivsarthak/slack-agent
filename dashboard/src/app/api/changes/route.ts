import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { tailJsonl } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const n = Math.min(500, Math.max(1, Number(request.nextUrl.searchParams.get("n") ?? 100)));
  const changes = await tailJsonl(path.join(agentPaths().stateDir, "vault-changes.jsonl"), n);
  return NextResponse.json({ changes: changes.reverse() });
}
