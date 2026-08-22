import { readFile, writeFile, rename } from "node:fs/promises";

export async function readJson<T = unknown>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
}

export async function readText(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** tmp + rename in the same directory, matching the agent's own write convention. */
export async function atomicWrite(p: string, contents: string): Promise<void> {
  const tmp = `${p}.dashboard-tmp`;
  await writeFile(tmp, contents, "utf8");
  await rename(tmp, p);
}

export async function tailJsonl<T = unknown>(p: string, n: number): Promise<T[]> {
  const text = await readText(p);
  if (!text) return [];
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n).flatMap((l) => {
    try {
      return [JSON.parse(l) as T];
    } catch {
      return [];
    }
  });
}
