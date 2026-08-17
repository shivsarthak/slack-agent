import { describe, expect, it } from "vitest";
import { RECORDED_CODEX_VERSION } from "../src/config.ts";
import { coworkerHarness, type PartialConnector } from "./support/harness.ts";

/**
 * Preflight: the instance either runs, or it says exactly what is wrong.
 *
 * The whole file is about one distinction, so it is worth stating once. Some things preflight
 * finds are **reports** — an instance that will work, described so a self-hoster can see what
 * they have configured. Others are **refusals** — an instance that would run perfectly while
 * being a different instance from the one the documentation describes. Nearly every test here
 * asserts which of the two a given condition is, because getting that wrong in either
 * direction is the actual failure: a refusal where a warning belonged locks somebody out of
 * their own tool, and a warning where a refusal belonged is a silent capability gain.
 *
 * The credential store is injected (`env`), so nothing here passes or fails because of what
 * happens to be exported in the shell that ran the tests.
 */

/** Linear's real shape, cut down: some reads, an upsert, and the two blocked verbs. */
const LINEAR_TOOLS = [
  "list_issues",
  "get_issue",
  "save_issue",
  "save_comment",
  "delete_comment",
  "delete_attachment",
  "merge_diff",
  "submit_diff_review",
];

function linear(overrides: Partial<PartialConnector> = {}): PartialConnector {
  return {
    name: "linear",
    url: "https://mcp.linear.app/mcp",
    bearerTokenEnvVar: "LINEAR_API_KEY",
    ...overrides,
  };
}

/** Whatever the environment has to hold for a given connector to be probed at all. */
const WITH_LINEAR_TOKEN = { LINEAR_API_KEY: "lin_api_test" };

describe("the engine and the bounds", () => {
  it("reports the installed engine version", async () => {
    const h = await coworkerHarness();
    h.engine.versionToReport = RECORDED_CODEX_VERSION;

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain(`Codex version ${RECORDED_CODEX_VERSION}`);
    expect(h.warnings).toEqual([]);
  });

  it("warns when the installed engine version has drifted from the recorded one", async () => {
    const h = await coworkerHarness();
    h.engine.versionToReport = "0.146.0-alpha.13";

    await h.coworker.preflight();

    const warning = h.warnings.join("\n");
    expect(warning).toContain("0.146.0-alpha.13");
    expect(warning).toContain(RECORDED_CODEX_VERSION);
  });

  it("reports the sandbox the engine actually puts a Job in", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    // Read off the adapter rather than restated, so this line cannot claim a posture the
    // engine does not configure. It is layer 2 for everything reached by shell.
    const logs = h.logs.join("\n");
    expect(logs).toContain("read-only");
    expect(logs).toMatch(/network disabled/);
    expect(logs).toMatch(/Approval Gate: coworker/);
    expect(logs).toMatch(/execpolicy every capability expansion is intercepted/);
  });

  it("reports the bounds, including one a self-hoster has lowered", async () => {
    const h = await coworkerHarness({ bounds: { turnTimeoutMs: 90_000 } });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("90s per Turn");
  });

  it("reports the default timeout and optional limits", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    const logs = h.logs.join("\n");
    expect(logs).toContain("21600s per Turn");
    expect(logs).toContain("no Turn cap");
    expect(logs).toContain("no token budget");
  });

  it("says where its configuration came from", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("Configuration: the test harness");
  });
});

describe("credentials", () => {
  it("refuses to start when Slack rejects the bot token", async () => {
    const h = await coworkerHarness();
    h.slack.failIdentity = new Error("invalid_auth");

    // The alternative is a Job that accepts work in a Thread, does it, and cannot say so.
    await expect(h.coworker.preflight()).rejects.toThrow(/invalid_auth/);
  });

  it("names the workspace and the bot user it connected as", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain("A Test Workspace");
  });

  it("refuses to start when a connector's bearer token variable is not set", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: {} });

    const failure = await h.coworker.preflight().catch((error: unknown) => error);

    // Both halves named: the variable, and the connector that asked for it.
    expect(String(failure)).toContain("LINEAR_API_KEY");
    expect(String(failure)).toContain("linear");
    // And it never reached the network — a probe with no credential fails as a transport
    // error, which reads like the server being down.
    expect(h.inventoryProber.probed).toEqual([]);
  });
});

describe("a connector's tool inventory", () => {
  it("reports the currently available tools", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    const logs = h.logs.join("\n");
    expect(logs).toContain(`Connector linear: ${LINEAR_TOOLS.length} tools`);
    expect(logs).toContain("inventory changes are allowed");
  });

  it("allows a server to add tools without blocking startup", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", {
      tools: [...LINEAR_TOOLS, "merge_and_deploy"],
    });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toContain(`${LINEAR_TOOLS.length + 1} tools`);
  });

  it("allows a server to remove tools without blocking startup", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", {
      tools: LINEAR_TOOLS.filter((tool) => tool !== "get_issue"),
    });

    await h.coworker.preflight();

    expect(h.logs.join("\n")).not.toContain("get_issue");
  });

  it("says so plainly when nothing is configured", async () => {
    const h = await coworkerHarness();

    await h.coworker.preflight();

    expect(h.logs.join("\n")).toMatch(/Connectors: none configured/);
  });
});

describe("the generated deny-list", () => {
  it("covers the irreversible tools without being asked to", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // A fixed floor independent of the server's changing inventory.
    const logs = h.logs.join("\n");
    expect(logs).toContain("merge_pull_request");
    expect(logs).toContain("merge_diff");
    expect(logs).toContain("submit_diff_review");
    expect(logs).toContain("delete_file");
    expect(logs).toContain("delete_comment");
    expect(logs).toContain("delete_attachment");
  });

  it("leaves the tools the coworker is meant to have", async () => {
    const h = await coworkerHarness({ mcpServers: [linear()], env: WITH_LINEAR_TOKEN });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // The criterion is "can a human undo this after noticing it in the Thread?", not
    // "is it a write" — `save_issue` is an upsert and stays available.
    const disabled = h.logs.join("\n").match(/tool name\(s\) disabled.*/)?.[0] ?? "";
    expect(disabled).not.toContain("save_issue");
    expect(disabled).not.toContain("list_issues");
  });

  it("takes anything else a self-hoster adds", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ disabledTools: ["save_comment"] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    const disabled = h.logs.join("\n").match(/tool name\(s\) disabled.*/)?.[0] ?? "";
    expect(disabled).toContain("save_comment");
    // Configuration adds to the floor; it cannot lower it.
    expect(disabled).toContain("merge_diff");
  });

  it("warns about a configured deny-list entry the server does not advertise", async () => {
    const h = await coworkerHarness({
      mcpServers: [linear({ disabledTools: ["delete_evrything"] })],
      env: WITH_LINEAR_TOKEN,
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });

    await h.coworker.preflight();

    // Harmless to Codex, and worth saying: somebody wrote that name believing it was
    // protecting them.
    expect(h.warnings.join("\n")).toContain("delete_evrything");
  });

  it("routes a newly added connector through the same floor", async () => {
    const h = await coworkerHarness({
      mcpServers: [
        linear(),
        {
          name: "wiki",
          url: "https://mcp.example.com/mcp",
          bearerTokenEnvVar: "WIKI_TOKEN",
        },
      ],
      env: { ...WITH_LINEAR_TOKEN, WIKI_TOKEN: "wiki_test" },
    });
    h.inventoryProber.inventories.set("linear", { tools: LINEAR_TOOLS });
    h.inventoryProber.inventories.set("wiki", {
      tools: ["get_page", "save_page", "delete_page"],
    });

    await h.coworker.preflight();

    // Every connector receives the same fixed irreversible-tool floor without needing a
    // reviewed inventory snapshot.
    expect(h.logs.join("\n")).toMatch(
      /Connector wiki: 8 exact tool name\(s\) disabled.*merge_diff/,
    );
  });
});

describe("the repository boundary", () => {
  it("warns and continues when a configured repository is missing protection", async () => {
    const h = await coworkerHarness({ repositories: ["acme/payments"] });
    h.repositoryProtection.protections.set("acme/payments", {
      status: "unprotected",
      defaultBranch: "main",
      missing: ["an approving review", "administrator bypass disabled"],
    });

    await h.coworker.preflight();

    expect(h.repositoryProtection.checked).toEqual(["acme/payments"]);
    const warning = h.warnings.join("\n");
    expect(warning).toContain("acme/payments");
    expect(warning).toContain("fixable");
    expect(warning).toContain("an approving review");
    expect(warning).toContain("administrator bypass disabled");
  });

  it("distinguishes a plan-gated repository and still starts", async () => {
    const h = await coworkerHarness({ repositories: ["acme/private-repo"] });
    h.repositoryProtection.protections.set("acme/private-repo", {
      status: "unprotectable",
      defaultBranch: "main",
      reason: "Upgrade to GitHub Pro or make this repository public",
    });

    await h.coworker.preflight();

    const warning = h.warnings.join("\n");
    expect(warning).toContain("acme/private-repo");
    expect(warning).toContain("unprotectable");
    expect(warning).toContain("Upgrade to GitHub Pro");
    expect(warning).toContain("will run without layer 3");
  });

  it("reports protected repositories without warning", async () => {
    const h = await coworkerHarness({
      repositories: ["acme/payments", "acme/ledger"],
    });

    await h.coworker.preflight();

    expect(h.repositoryProtection.checked).toEqual(["acme/payments", "acme/ledger"]);
    expect(h.logs.join("\n")).toContain("acme/payments");
    expect(h.logs.join("\n")).toContain("acme/ledger");
    expect(h.warnings).toEqual([]);
  });
});
