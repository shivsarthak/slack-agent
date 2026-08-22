import { NextRequest, NextResponse } from "next/server";
import { OPERATING_MANUAL_MAX_BYTES } from "@agent/config.ts";
import { atomicWrite, readText } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET() {
  const text = await readText(agentPaths().manualPath);
  if (text === null) return NextResponse.json({ error: "operating manual not found" }, { status: 404 });
  return NextResponse.json({ content: text, maxBytes: OPERATING_MANUAL_MAX_BYTES });
}

export async function PUT(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { content?: string } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: "expected { content: string }" }, { status: 400 });
  }
  const bytes = Buffer.byteLength(body.content, "utf8");
  if (bytes > OPERATING_MANUAL_MAX_BYTES) {
    return NextResponse.json(
      { error: `manual is ${bytes} bytes; the agent enforces a ${OPERATING_MANUAL_MAX_BYTES}-byte ceiling` },
      { status: 422 },
    );
  }
  await atomicWrite(agentPaths().manualPath, body.content);
  return NextResponse.json({ ok: true, bytes });
}
