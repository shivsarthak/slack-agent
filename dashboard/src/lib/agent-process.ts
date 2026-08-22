import path from "node:path";
import { stat, writeFile } from "node:fs/promises";
import { readJson } from "@/lib/files";
import { agentPaths } from "@/lib/paths";

interface Pidfile {
  pid: number;
  startedAt: string;
}

export interface AgentStatus {
  running: boolean;
  pid: number | null;
  startedAt: string | null;
  restartRequired: boolean;
}

async function mtimeMs(p: string): Promise<number> {
  try {
    return (await stat(p)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readPidfile(): Promise<Pidfile | null> {
  const { stateDir } = agentPaths();
  const pidfile = await readJson<Pidfile>(path.join(stateDir, "agent.pid"));
  if (!pidfile || typeof pidfile.pid !== "number") return null;
  return pidfile;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function agentStatus(): Promise<AgentStatus> {
  const { configPath, mcpPath } = agentPaths();
  const pidfile = await readPidfile();
  const running = pidfile !== null && isAlive(pidfile.pid);
  const startedAt = pidfile ? Date.parse(pidfile.startedAt) : 0;
  const lastConfigWrite = Math.max(await mtimeMs(configPath), await mtimeMs(mcpPath));
  return {
    running,
    pid: running && pidfile ? pidfile.pid : null,
    startedAt: pidfile?.startedAt ?? null,
    // The pidfile's startedAt has second precision, so allow a 2s tie window —
    // a config write in the same second as the respawn is the restart's own cause.
    restartRequired: running && lastConfigWrite > startedAt + 2000,
  };
}

/** SIGTERM the agent; the run-agent.sh supervisor loop respawns it. */
export async function restartAgent(): Promise<{ ok: boolean; error?: string }> {
  const pidfile = await readPidfile();
  if (!pidfile || !isAlive(pidfile.pid)) {
    return { ok: false, error: "Agent is not running under scripts/run-agent.sh (no live pidfile)." };
  }
  try {
    // The marker tells run-agent.sh this is a restart, not a stop: the agent
    // exits 0 on SIGTERM, which would otherwise end the supervisor loop.
    await writeFile(path.join(agentPaths().stateDir, "agent.restart"), "");
    process.kill(pidfile.pid, "SIGTERM");
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
