import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * The disk-backed temporary and package-cache root a Job's sandbox writes to.
 *
 * `workspace-write` grants `$TMPDIR` and `/tmp` unconditionally, whatever the writable list
 * says (ADR-0004). On a Linux host `/tmp` is frequently a small **tmpfs** — RAM, not disk —
 * so a Job that treats it as scratch space spends memory and can exhaust the shared volume
 * for every other Job on the machine. That is exactly the September 2026 incident behind
 * [issue #26](https://github.com/shivsarthak/slack-agent/issues/26): a single monorepo
 * `pnpm install` pointed its package store at `/tmp` and filled a 1.9 GiB tmpfs, after which
 * unrelated Jobs failed to launch because the sandbox could not create `/tmp/.git`.
 *
 * The wrapper cannot stop the engine from running a large install, but it *does* choose the
 * environment that install inherits. Pointing `TMPDIR` and each package manager's cache and
 * store at a directory on the same filesystem as the wrapper's own state keeps that bulk
 * data off RAM and off the shared `/tmp`, and under a path the wrapper owns and can clean up.
 *
 * The value is deliberately **one per instance rather than one per Thread**. The Codex SDK
 * fixes a subprocess's environment at `new Codex(...)` time and has no per-thread equivalent,
 * so a per-Thread root is not expressible through the engine seam. One shared root is enough
 * for the failure it addresses — it moves the data to disk — and it keeps every Job's caches
 * in a single place a retention sweep can find.
 */
export function sandboxRoot(stateDir: string): string {
  return path.join(stateDir, "sandbox");
}

/**
 * The environment handed to the Codex subprocess, with temporary and cache locations moved
 * onto disk under {@link sandboxRoot}.
 *
 * `base` is the wrapper's own environment and is preserved: the credential store names
 * environment variables, and dropping them would break every connector and Schedule at once
 * (ADR-0005). Only the variables below are overridden.
 *
 * The SDK's `env` option **replaces** the subprocess environment rather than extending it, so
 * callers must spread `process.env` in themselves. {@link buildSandboxEnv} is the one place
 * that knows the full set of names, so a manager added here reaches every Job.
 */
export function buildSandboxEnv(
  base: NodeJS.ProcessEnv,
  root: string,
): Record<string, string> {
  const temp = path.join(root, "tmp");
  const cache = path.join(root, "cache");
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }

  // Temporary directories. `TMPDIR` is the POSIX convention and the one Codex's
  // `workspace-write` sandbox grants unconditionally; `TMP`/`TEMP` cover Windows-style
  // lookups so a manager that reads those does not fall back to the platform default.
  env.TMPDIR = temp;
  env.TMP = temp;
  env.TEMP = temp;

  // A home for caches that respect the XDG spec but predate agreement on a name.
  env.XDG_CACHE_HOME = cache;

  // The package managers. pnpm and Yarn stores are the specific writers from the incident;
  // npm and Bun are included so the same fix covers the sibling tools a Job might reach for.
  // `npm_config_*` is case-sensitive on Linux — the lowercase spelling is the one npm reads.
  env.npm_config_cache = path.join(cache, "npm");
  env.npm_config_store_dir = path.join(cache, "pnpm-store");
  env.PNPM_HOME = path.join(root, "pnpm");
  env.PNPM_STORE_DIR = path.join(cache, "pnpm-store");
  env.COREPACK_HOME = path.join(cache, "corepack");
  env.YARN_CACHE_FOLDER = path.join(cache, "yarn");
  env.BUN_INSTALL_CACHE_DIR = path.join(cache, "bun");

  return env;
}

/**
 * Create the sandbox root's subdirectories, so the first Job does not race every other Job
 * to `mkdir` them and the preflight check has something real to stat.
 *
 * Synchronous and best-effort: the engine is constructed on the startup path, and a failure
 * here should surface as the Job's own error rather than abort startup. The directories are
 * recreated on demand by the tools that use them in any case.
 */
export function prepareSandboxRoot(root: string): void {
  for (const directory of ["tmp", "cache"]) {
    mkdirSync(path.join(root, directory), { recursive: true });
  }
}
