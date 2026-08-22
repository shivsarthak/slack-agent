import path from "node:path";
import { readFileSync } from "node:fs";

/** Repo root of the agent. The dashboard lives in <root>/dashboard by default. */
export const AGENT_ROOT = path.resolve(
  process.env.AGENT_ROOT ?? path.join(process.cwd(), ".."),
);

export const CONFIG_PATH = process.env.CONFIG_PATH
  ? path.resolve(AGENT_ROOT, process.env.CONFIG_PATH)
  : path.join(AGENT_ROOT, "open-agent.config.json");

const configDir = path.dirname(CONFIG_PATH);

interface RawConfig {
  vault?: { notes?: string; skills?: string };
  stateDir?: string;
  operatingManual?: string;
  mcpConfig?: string;
}

function rawConfig(): RawConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as RawConfig;
  } catch {
    return {};
  }
}

/** Resolve the agent's data paths the same way src/config.ts does: relative to the config file. */
export function agentPaths() {
  const c = rawConfig();
  const rel = (p: string) => path.resolve(configDir, p);
  const notesDir = rel(c.vault?.notes ?? "./vault/Notes");
  const skillsDir = c.vault?.skills
    ? rel(c.vault.skills)
    : path.join(path.dirname(notesDir), "Skills");
  return {
    configPath: CONFIG_PATH,
    stateDir: rel(c.stateDir ?? "./.state"),
    notesDir,
    skillsDir,
    manualPath: rel(c.operatingManual ?? "./assets/operating-manual.md"),
    mcpPath: rel(c.mcpConfig ?? "./mcp.json"),
  };
}
