import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { agentPaths } from "@/lib/paths";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { notesDir } = agentPaths();
  const name = request.nextUrl.searchParams.get("name");
  if (name) {
    const base = path.basename(name);
    if (base !== name || !base.endsWith(".md")) {
      return NextResponse.json({ error: "invalid note name" }, { status: 400 });
    }
    try {
      return NextResponse.json({ name, content: await readFile(path.join(notesDir, base), "utf8") });
    } catch {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
  }
  let names: string[] = [];
  try {
    names = (await readdir(notesDir)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return NextResponse.json({ notes: [], missingDir: true });
  }
  const notes = await Promise.all(
    names.map(async (n) => {
      const s = await stat(path.join(notesDir, n));
      return { name: n, modifiedAt: s.mtime.toISOString(), bytes: s.size };
    }),
  );
  return NextResponse.json({ notes });
}
