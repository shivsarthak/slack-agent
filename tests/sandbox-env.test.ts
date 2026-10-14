import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  buildSandboxEnv,
  prepareSandboxRoot,
  sandboxRoot,
} from "../src/engine/sandbox-env.ts";
import { testTempDir } from "./support/test-root.ts";

/**
 * Where a Job's temporary files and package caches are pointed.
 *
 * The failure this guards is concrete and recorded: a single `pnpm install` chose the host's
 * shared, RAM-backed `/tmp` as its store, filled it, and every other Job on the machine then
 * failed to launch (issue #26). The fix is an environment that sends that data to a
 * disk-backed directory the wrapper owns, so the properties under test are that the variables
 * move somewhere disk-backed, that the base environment survives, and that no accidental
 * empty override is introduced.
 */

describe("the sandbox environment", () => {
  it("sends temporary files and every package store to the chosen root", () => {
    const env = buildSandboxEnv({}, "/srv/open-agent/state/sandbox");

    expect(env.TMPDIR).toBe("/srv/open-agent/state/sandbox/tmp");
    expect(env.TMP).toBe("/srv/open-agent/state/sandbox/tmp");
    expect(env.TEMP).toBe("/srv/open-agent/state/sandbox/tmp");
    expect(env.XDG_CACHE_HOME).toBe("/srv/open-agent/state/sandbox/cache");
    // The specific writer from the incident, plus its siblings.
    expect(env.npm_config_store_dir).toBe("/srv/open-agent/state/sandbox/cache/pnpm-store");
    expect(env.PNPM_STORE_DIR).toBe("/srv/open-agent/state/sandbox/cache/pnpm-store");
    expect(env.npm_config_cache).toBe("/srv/open-agent/state/sandbox/cache/npm");
    expect(env.COREPACK_HOME).toBe("/srv/open-agent/state/sandbox/cache/corepack");
    expect(env.YARN_CACHE_FOLDER).toBe("/srv/open-agent/state/sandbox/cache/yarn");
    expect(env.BUN_INSTALL_CACHE_DIR).toBe("/srv/open-agent/state/sandbox/cache/bun");
  });

  it("keeps the wrapper's own environment so named credentials still resolve", () => {
    const env = buildSandboxEnv(
      { PATH: "/usr/bin", GITHUB_TOKEN: "ghp_secret", LINEAR_API_KEY: "lin_api_x" },
      "/srv/sandbox",
    );

    expect(env.PATH).toBe("/usr/bin");
    expect(env.GITHUB_TOKEN).toBe("ghp_secret");
    expect(env.LINEAR_API_KEY).toBe("lin_api_x");
  });

  it("drops undefined entries rather than inventing empty variables", () => {
    const env = buildSandboxEnv({ SET: "here", UNSET: undefined }, "/srv/sandbox");

    expect(env.SET).toBe("here");
    expect(env).not.toHaveProperty("UNSET");
  });

  it("roots the sandbox under the wrapper's own state directory", () => {
    expect(sandboxRoot("/srv/open-agent/.state")).toBe("/srv/open-agent/.state/sandbox");
  });

  it("creates the writable temporary and cache directories up front", async () => {
    const root = await testTempDir("sandbox-root-");
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const sandbox = sandboxRoot(root);

    prepareSandboxRoot(sandbox);

    expect((await stat(path.join(sandbox, "tmp"))).isDirectory()).toBe(true);
    expect((await stat(path.join(sandbox, "cache"))).isDirectory()).toBe(true);
  });

  it("lands the directories on the same filesystem as the state directory", async () => {
    const dir = await mkdtemp(path.join(await testTempDir("sandbox-fs-"), "state-"));
    onTestFinished(() => rm(path.dirname(dir), { recursive: true, force: true }));

    const sandbox = sandboxRoot(dir);
    prepareSandboxRoot(sandbox);

    // A path under `stateDir` is the whole point: it is the volume the self-hoster chose,
    // not whatever `/tmp` happens to be. Its absolute root cannot be the sandbox's own.
    expect(sandbox.startsWith(dir)).toBe(true);
    expect(path.isAbsolute(sandbox)).toBe(true);
  });
});
