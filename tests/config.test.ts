import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  BOUND_DEFAULTS,
  DEFAULT_CONFIG_FILENAME,
  FILE_TRANSFER_DEFAULTS,
  WORKSPACE_RETENTION_DEFAULTS,
  loadConfig,
  type ConfigFile,
} from "../src/config.ts";
import { NOTES_DIRNAME, SKILLS_DIRNAME } from "../src/vault/skills.ts";
import { testTempDir } from "./support/test-root.ts";

/**
 * Instance configuration, one MCP registry, and secrets in the environment.
 *
 * The property under test throughout is that the two never swap places. The file names
 * credentials and never contains them, so it is safe to commit; the environment holds them
 * and configures nothing else, so an instance cannot end up running with a bound nobody
 * wrote down. Every test here is about one edge of that split, or about a message being
 * good enough to act on — which for a startup failure is the whole feature.
 *
 * A real file in a real directory, because "relative paths resolve against the file" is a
 * claim about the filesystem.
 */

/** A configuration file on disk, and the environment that goes with it. */
async function configFile(
  contents: ConfigFile | string,
): Promise<{ dir: string; filePath: string }> {
  const dir = await testTempDir("open-agent-config-");
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, DEFAULT_CONFIG_FILENAME);
  await writeFile(
    filePath,
    typeof contents === "string" ? contents : JSON.stringify(contents, undefined, 2),
    "utf8",
  );
  return { dir, filePath };
}

async function writeMcp(dir: string, contents: unknown): Promise<string> {
  const filePath = path.join(dir, "mcp.json");
  await writeFile(filePath, JSON.stringify(contents, undefined, 2), "utf8");
  return filePath;
}

/** The two credentials every instance needs, under the names the defaults expect. */
const SLACK_TOKENS = { SLACK_BOT_TOKEN: "xoxb-test", SLACK_APP_TOKEN: "xapp-test" };

describe("the configuration file", () => {
  it("needs no configuration file at all", async () => {
    // The walking skeleton's shape — a Slack bot with a Vault and no connectors. Requiring
    // an empty file to say so would be ceremony. Asserted on the source rather than on the
    // values, because whether this developer's checkout happens to have a real
    // `open-agent.config.json` in it is not this test's business.
    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: "" });

    expect(config.source).toContain(DEFAULT_CONFIG_FILENAME);
  });

  it("runs on the shipped defaults when the file says nothing", async () => {
    const { filePath } = await configFile({});

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.bounds).toEqual(BOUND_DEFAULTS);
    expect(config.mcpServers).toEqual([]);
    expect(path.basename(config.notesDir)).toBe(NOTES_DIRNAME);
    expect(config.engine.reasoningEffort).toBe("low");
    expect(config.fileTransfer).toEqual(FILE_TRANSFER_DEFAULTS);
    expect(config.workspaceRetention).toEqual(WORKSPACE_RETENTION_DEFAULTS);
    expect(config.approvals).toEqual({ mode: "coworker", rules: [] });
  });

  it("loads strict approval modes, policy, and deterministic rules", async () => {
    const { filePath } = await configFile({
      approvals: {
        mode: "external-writes",
        policy: "Creating pull requests in acme/shop is allowed.",
        rules: [{ source: "mcp", server: "github", tool: "create_pull_request", scope: "acme/shop", decision: "allow" }],
      },
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });
    expect(config.approvals.mode).toBe("external-writes");
    expect(config.approvals.policy).toContain("acme/shop");
    expect(config.approvals.rules).toHaveLength(1);
  });

  it("refuses unknown approval modes and keys", async () => {
    const badMode = await configFile({ approvals: { mode: "all-writes" } } as unknown as ConfigFile);
    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: badMode.filePath })).rejects.toThrow("approvals.mode");
    const badKey = await configFile({ approvals: { mode: "coworker", unknownMeansAllow: true } } as unknown as ConfigFile);
    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: badKey.filePath })).rejects.toThrow("unknownMeansAllow");
  });

  it("takes the inactive workspace lifetime from the instance file", async () => {
    const { filePath } = await configFile({ workspaceRetention: { inactivityMs: 7_200_000 } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.workspaceRetention.inactivityMs).toBe(7_200_000);
  });

  it("refuses to start when it was told where the file is and there is nothing there", async () => {
    const missing = path.join(await testTempDir("open-agent-config-"), "nope.json");

    // Silently running defaults instead would hide the typo in the one place it matters.
    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: missing })).rejects.toThrow(
      /cannot be read/,
    );
  });

  it("resolves relative paths against the file rather than the working directory", async () => {
    const { dir, filePath } = await configFile({ vault: { notes: "./brain/Notes" } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    // So a checkout that moves stays configured, and so `./` in a config file means what
    // somebody reading that file would assume.
    expect(config.notesDir).toBe(path.join(dir, "brain", "Notes"));
  });

  it("keeps the Skills beside the Notes when only the Notes have moved", async () => {
    const { dir, filePath } = await configFile({ vault: { notes: "./brain/Notes" } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    // The sibling relationship is the layout the write boundary depends on, so it is what a
    // partial configuration falls back to — never the shipped default, which would be an
    // empty directory the coworker is told about and a real one nobody reads.
    expect(config.skillsDir).toBe(path.join(dir, "brain", SKILLS_DIRNAME));
  });

  it("takes a per-Job bound a self-hoster wrote and leaves the rest disabled", async () => {
    const { filePath } = await configFile({ bounds: { turnTimeoutMs: 90_000 } });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.bounds.turnTimeoutMs).toBe(90_000);
    expect(config.bounds.maxTurnsPerJob).toBeUndefined();
    expect(config.bounds.tokenBudgetPerJob).toBeUndefined();
  });

  it("refuses a Job timeout of 24 hours or more", async () => {
    const { filePath } = await configFile({ bounds: { turnTimeoutMs: 86_400_000 } });

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      "bounds.turnTimeoutMs",
    );
  });

  it("takes independent Slack download and upload size ceilings", async () => {
    const { filePath } = await configFile({
      fileTransfer: { maxDownloadBytes: 1_000_000, maxUploadBytes: 2_000_000 },
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.fileTransfer).toEqual({
      maxDownloadBytes: 1_000_000,
      maxUploadBytes: 2_000_000,
    });
  });

  it("loads the repositories whose default branches preflight must verify", async () => {
    const { dir, filePath } = await configFile({
      mcpConfig: "./mcp.json",
      repositories: ["acme/payments", "acme/ledger"],
    });
    await writeMcp(dir, {
      mcpServers: {
        github: {
          type: "streamable-http",
          url: "https://api.githubcopilot.com/mcp/",
          bearerTokenEnvVar: "GITHUB_TOKEN",
        },
      },
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    expect(config.repositories).toEqual(["acme/payments", "acme/ledger"]);
  });

  it("refuses a key it does not recognise, naming it", async () => {
    const { filePath } = await configFile({ bounds: { turnTimeutMs: 90_000 } } as ConfigFile);

    // A misspelled key that parsed and did nothing would be an instance running with a
    // bound its operator believes they set.
    const failure = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("turnTimeutMs");
  });

  it("refuses a repository name that could alter the GitHub request URL", async () => {
    const { filePath } = await configFile({
      repositories: ["acme/payments?visibility=public"],
    });

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /owner\/repository/,
    );
  });

  it("refuses a bound that is not a number", async () => {
    const { filePath } = await configFile({
      bounds: { turnTimeoutMs: "an hour" },
    } as unknown as ConfigFile);

    const failure = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath }).catch(
      (error: unknown) => error,
    );

    expect(String(failure)).toContain("bounds.turnTimeoutMs");
  });

  it("parses the example this project ships", async () => {
    // The example is documentation that runs, and a shipped example that does not validate
    // is worse than none: it is the first thing a self-hoster copies.
    const repo = path.resolve(import.meta.dirname, "..");
    const example = JSON.parse(
      await readFile(path.join(repo, "open-agent.config.example.json"), "utf8"),
    ) as ConfigFile;
    const mcpExample = JSON.parse(
      await readFile(path.join(repo, "mcp.example.json"), "utf8"),
    ) as unknown;
    const { dir, filePath } = await configFile(example);
    await writeMcp(dir, mcpExample);

    const config = await loadConfig({
      ...SLACK_TOKENS,
      CONFIG_PATH: filePath,
      LINEAR_API_KEY: "lin_api_test",
    });

    expect(config.mcpServers.map((server) => server.name)).toEqual([
      "github",
      "linear",
      "example-local-server",
    ]);
    const github = config.mcpServers.find((server) => server.name === "github");
    expect(github?.enabled).toBe(false);
    expect(github?.disabledTools).toEqual(["merge_pull_request", "delete_file"]);
  });

  it("says which file was not valid JSON", async () => {
    const { filePath } = await configFile('{ "bounds": { }');

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /not valid JSON/,
    );
  });
});

describe("credentials, which the file names and never holds", () => {
  it("refuses to start when a named credential is not in the environment", async () => {
    const { filePath } = await configFile({});

    const failure = await loadConfig({
      CONFIG_PATH: filePath,
      SLACK_APP_TOKEN: "xapp-test",
    }).catch((error: unknown) => error);

    // Both halves named, because either could be the mistake and the reader cannot tell
    // which from "SLACK_BOT_TOKEN is not set" alone.
    expect(String(failure)).toContain("SLACK_BOT_TOKEN");
    expect(String(failure)).toContain(filePath);
  });

  it("reads a credential out of whatever variable the file names", async () => {
    const { filePath } = await configFile({
      slack: { botTokenEnvVar: "WORK_SLACK_BOT_TOKEN" },
    });

    const config = await loadConfig({
      CONFIG_PATH: filePath,
      WORK_SLACK_BOT_TOKEN: "xoxb-work",
      SLACK_APP_TOKEN: "xapp-test",
    });

    // Which is how one machine runs two instances against two workspaces.
    expect(config.slack.botToken).toBe("xoxb-work");
  });

});

describe("connectors, which the file is the only record of", () => {
  it("refuses repositories it cannot verify without an enabled GitHub connector", async () => {
    const { filePath } = await configFile({
      repositories: ["acme/payments"],
    });

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /enabled GitHub connector/,
    );
  });

  it("carries the token's variable name without requiring policy lists", async () => {
    const { dir, filePath } = await configFile({ mcpConfig: "./mcp.json" });
    await writeMcp(dir, {
      mcpServers: {
        linear: {
          type: "streamable-http",
          url: "https://mcp.linear.app/mcp",
          bearerTokenEnvVar: "LINEAR_API_KEY",
        },
      },
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });

    const [linear] = config.mcpServers;
    expect(linear?.transport).toBe("http");
    expect(linear?.transport === "http" ? linear.bearerTokenEnvVar : undefined).toBe(
      "LINEAR_API_KEY",
    );
    expect(linear?.disabledTools).toEqual([]);
    // Nothing resolved the token while loading configuration. Codex reads it for MCP calls;
    // startup resolves it separately only when checking configured repository protection.
    expect(JSON.stringify(config)).not.toContain("lin_api");
  });

  it("loads stdio servers and resolves their working directory beside mcp.json", async () => {
    const { dir, filePath } = await configFile({ mcpConfig: "./mcp.json" });
    await writeMcp(dir, {
      mcpServers: {
        local: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@vendor/server@1.2.3"],
          cwd: "./tools",
          envVars: ["LOCAL_TOKEN"],
        },
      },
    });

    const config = await loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath });
    const [local] = config.mcpServers;

    expect(local?.transport).toBe("stdio");
    expect(local?.transport === "stdio" ? local.cwd : undefined).toBe(path.join(dir, "tools"));
    expect(local?.transport === "stdio" ? local.envVars : []).toEqual(["LOCAL_TOKEN"]);
  });

  it("refuses static headers owned by the MCP transport", async () => {
    const { dir, filePath } = await configFile({ mcpConfig: "./mcp.json" });
    await writeMcp(dir, {
      mcpServers: {
        unsafe: {
          type: "streamable-http",
          url: "https://mcp.example.com/mcp",
          httpHeaders: { Authorization: "Bearer plaintext-secret" },
        },
      },
    });

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /bearerTokenEnvVar/,
    );
  });

  it("fails when an explicitly named MCP registry is missing", async () => {
    const { filePath } = await configFile({ mcpConfig: "./missing-mcp.json" });

    await expect(loadConfig({ ...SLACK_TOKENS, CONFIG_PATH: filePath })).rejects.toThrow(
      /missing-mcp\.json cannot be read/,
    );
  });
});
