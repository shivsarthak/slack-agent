import path from "node:path";
import { execFile } from "node:child_process";
import { stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
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
  /**
   * Agent processes running OUTSIDE the supervisor — e.g. a `node src/index.ts`
   * started by hand in a terminal. These connect to the same Slack app over
   * Socket Mode and silently take a share of the mentions, but the restart
   * button cannot reach them: it only signals the pid in `.state/agent.pid`.
   */
  strayPids: number[];
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

/**
 * Every agent process on this machine that the supervisor does not own.
 *
 * `ps` rather than a lockfile: a stray instance predates any lock this code
 * could have taken, and the point is to *see* it, not to fence it out. The
 * match is deliberately narrow — the exact entrypoint under Node's
 * type-stripping flag — so the dashboard's own `next dev` and unrelated
 * projects never trip it.
 */
async function strayAgentPids(supervisedPid: number | null): Promise<number[]> {
  try {
    const { stdout } = await promisify(execFile)("ps", ["ax", "-o", "pid=,command="]);
    return stdout.split("\n").flatMap((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) return [];
      const pid = Number(match[1]);
      if (!/--experimental-strip-types src\/index\.ts/.test(match[2] ?? "")) return [];
      return pid === supervisedPid ? [] : [pid];
    });
  } catch {
    return [];
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
    strayPids: await strayAgentPids(running && pidfile ? pidfile.pid : null),
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
