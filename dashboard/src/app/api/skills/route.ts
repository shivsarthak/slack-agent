import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { agentPaths } from "@/lib/paths";
import { safeSkillPath } from "@/lib/skills";

export const dynamic = "force-dynamic";

export async function GET() {
  const { skillsDir } = agentPaths();
  let names: string[] = [];
  try {
    names = (await readdir(skillsDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return NextResponse.json({ skills: [], missingDir: true });
  }
  const skills = await Promise.all(
    names.map(async (name) => {
      const s = await stat(path.join(skillsDir, name));
      return { name, modifiedAt: s.mtime.toISOString(), bytes: s.size };
    }),
  );
  return NextResponse.json({ skills });
}

export async function POST(request: NextRequest) {
  const body = (await request.json().catch(() => null)) as { name?: string; content?: string } | null;
  if (!body?.name || typeof body.content !== "string") {
    return NextResponse.json({ error: "expected { name, content }" }, { status: 400 });
  }
  const target = safeSkillPath(body.name);
  if (!target) return NextResponse.json({ error: "invalid skill name" }, { status: 400 });
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body.content, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return NextResponse.json({ error: "a skill with that name already exists" }, { status: 409 });
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
  return NextResponse.json({ ok: true, name: path.basename(target) });
}
