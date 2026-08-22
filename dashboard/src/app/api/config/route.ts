import { NextRequest, NextResponse } from "next/server";
import { configFileSchema } from "@agent/config.ts";
import { atomicWrite, readText } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const text = await readText(agentPaths().configPath);
  if (text === null) return NextResponse.json({ error: "config file not found" }, { status: 404 });
  return NextResponse.json(JSON.parse(text));
}

export async function PUT(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (body === null) return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  const parsed = configFileSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation failed", issues: parsed.error.issues }, { status: 422 });
  }
  await atomicWrite(agentPaths().configPath, JSON.stringify(body, null, 2) + "\n");
  return NextResponse.json({ ok: true, restartRequired: true });
}
