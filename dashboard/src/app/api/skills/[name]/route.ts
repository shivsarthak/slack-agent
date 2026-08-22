import { readFile, unlink } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { atomicWrite } from "@/lib/files";
import { safeSkillPath } from "@/lib/skills";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ name: string }> };

export async function GET(_request: NextRequest, { params }: Params) {
  const { name } = await params;
  const target = safeSkillPath(decodeURIComponent(name));
  if (!target) return NextResponse.json({ error: "invalid skill name" }, { status: 400 });
  try {
    return NextResponse.json({ name, content: await readFile(target, "utf8") });
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
}

export async function PUT(request: NextRequest, { params }: Params) {
  const { name } = await params;
  const target = safeSkillPath(decodeURIComponent(name));
  if (!target) return NextResponse.json({ error: "invalid skill name" }, { status: 400 });
  const body = (await request.json().catch(() => null)) as { content?: string } | null;
  if (typeof body?.content !== "string") {
    return NextResponse.json({ error: "expected { content: string }" }, { status: 400 });
  }
  await atomicWrite(target, body.content);
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  const { name } = await params;
  const target = safeSkillPath(decodeURIComponent(name));
  if (!target) return NextResponse.json({ error: "invalid skill name" }, { status: 400 });
  try {
    await unlink(target);
  } catch {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
