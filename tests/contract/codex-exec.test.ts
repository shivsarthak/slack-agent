import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RECORDED_CODEX_VERSION } from "../../src/config.ts";
import { createCodexEngine } from "../../src/engine/codex.ts";
import type { Engine, EngineEvent } from "../../src/ports/engine.ts";
import { changesBetween, snapshotVault } from "../../src/vault/snapshot.ts";
import { readSkills, skillsForPrompt } from "../../src/vault/skills.ts";
import { writeScope, writesIn, type Write } from "../../src/writes/classify.ts";
import { testTempDir } from "../support/test-root.ts";

/**
 * The contract seam.
 *
 * These tests run a **real Codex App Server**, so they need working Codex credentials
 * and they cost tokens. They are excluded from `pnpm test` and run with
 * `pnpm test:contract`.
 *
 * They exist because this is the one place a fake can drift from reality, and v1
 * pins no Codex version: with multiple upstream alphas a day, this suite is what
 * stands between an alpha that changed the event stream and an instance that is
 * silently broken. Run it against whatever version is installed, not only at a
 * deliberate bump.
 *
 * Cover only what a fake cannot honestly assert. Everything else belongs at the top
 * seam in `tests/coworker.test.ts`.
 */

let engine: Engine;
let workspace: string;

beforeAll(async () => {
  engine = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low", approvalMode: "off" });
  workspace = await mkdtemp(path.join(os.tmpdir(), "open-agent-contract-"));
  await writeFile(
    path.join(workspace, "AGENTS.md"),
    "# Operating manual\n\nAnswer exactly what you are asked, with no preamble.\n",
    "utf8",
  );
});

afterAll(async () => {
  await engine.close();
  await rm(workspace, { recursive: true, force: true });
});

describe("the real engine", () => {
  it("reports the version that will actually run", async () => {
    const version = await engine.version();

    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    if (version !== RECORDED_CODEX_VERSION) {
      console.warn(
        `Codex ${version} is installed; this project records ${RECORDED_CODEX_VERSION}. ` +
          "If the assertions below fail, upstream changed something.",
      );
    }
  });

  it("translates a real turn's event stream into the wrapper's events", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const events: EngineEvent[] = [];
    for await (const event of session.run(
      'Reply with exactly the word PONG and nothing else. Do not run any commands.',
    )) {
      events.push(event);
    }

    const types = events.map((event) => event.type);
    expect(types).toContain("session-started");
    expect(types).toContain("turn-started");
    expect(types).toContain("turn-completed");
    expect(types).not.toContain("turn-failed");

    const started = events.find((event) => event.type === "session-started");
    expect(started?.type === "session-started" && started.sessionId).toMatch(/[0-9a-f-]{36}/);
    // The Session's identity is what the wrapper persists against a Thread.
    expect(session.id).toBe(started?.type === "session-started" ? started.sessionId : undefined);

    const answers = events.flatMap((event) => (event.type === "message" ? [event.text] : []));
    expect(answers.at(-1)).toContain("PONG");

    const completed = events.find((event) => event.type === "turn-completed");
    expect(completed?.type === "turn-completed" && completed.usage?.outputTokens).toBeGreaterThan(
      0,
    );
  });

  it("resumes a Session in a fresh process, remembering what it was told", async () => {
    const first = engine.startSession({ workingDirectory: workspace });
    for await (const event of first.run(
      "Remember this for later: the deploy codeword is `saltmarsh`. Reply with just OK.",
    )) {
      if (event.type === "turn-failed") throw new Error(event.message);
    }
    const sessionId = first.id;
    expect(sessionId).toMatch(/[0-9a-f-]{36}/);

    // A second engine over the same installed Codex, sharing nothing with the first
    // but the identifier — which is exactly what the wrapper persists and all it has
    // after a restart. The Session's content is on Codex's disk, not in this process.
    await engine.close();
    const restarted = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low", approvalMode: "off" });
    engine = restarted;
    const resumed = restarted.resumeSession(sessionId!, { workingDirectory: workspace });

    const answers: string[] = [];
    for await (const event of resumed.run("What was the deploy codeword? Reply with just the word.")) {
      if (event.type === "message") answers.push(event.text);
      if (event.type === "turn-failed") throw new Error(event.message);
    }

    expect(answers.at(-1)?.toLowerCase()).toContain("saltmarsh");
    expect(resumed.id).toBe(sessionId);
  });

  /**
   * Ticket 02 asks that the coworker **cannot** reach Codex's own session storage,
   * verified rather than assumed. This is the verification, and it currently fails to
   * find any such guarantee: under `workspace-write` the sandbox allows reads
   * anywhere, `codex exec` exposes no way to narrow them (`--permission-profile` and
   * its readable roots are not on `exec`, and `sandbox_permissions=[]` is inert), so a
   * Job can list every Thread's rollout file.
   *
   * The assertion is therefore written the way the finding actually is. **If this test
   * starts failing, that is good news**: upstream has restricted reads, and ADR-0003's
   * "Sessions never read each other" can be upgraded from a behavioural guarantee to a
   * structural one. See the comments on ticket 02.
   */
  it("cannot yet be prevented from reading Codex's own session storage", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const outputs: string[] = [];
    for await (const event of session.run(
      'Run the shell command `find "$HOME/.codex/sessions" -name "*.jsonl" | head -2` ' +
        "and report its output verbatim. Do not do anything else.",
    )) {
      if (event.type === "command" && event.status === "completed") outputs.push(event.output);
    }

    // Asserted on the rollout filenames themselves rather than on the absence of a
    // denial message: "no such file or directory" is also not a denial, and a test that
    // passed on it would report this hole as closed when the directory had merely moved.
    expect(outputs.join("\n")).toMatch(/rollout-[\dT-]+-[0-9a-f-]{36}\.jsonl/);
  });

  /**
   * The status message is the engine's own todo list, so two facts about `exec` are
   * load-bearing and neither can be honestly asserted against a fake: that a plan is
   * emitted at all, and that it is **revised** mid-Turn rather than reported once at
   * the end. Without the second, "which step it is on" has nothing to show.
   */
  it("emits a todo list, and revises it as it works", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const plans: EngineEvent[] = [];
    const commands: EngineEvent[] = [];
    for await (const event of session.run(
      "Use your plan tool to record these three steps before starting, then carry them " +
        "out, marking each one complete as you finish it: (1) run `echo one`, " +
        "(2) run `echo two`, (3) reply with just DONE.",
    )) {
      if (event.type === "plan") plans.push(event);
      if (event.type === "command") commands.push(event);
    }

    const steps = plans.flatMap((event) => (event.type === "plan" ? [event.steps] : []));
    expect(steps.length).toBeGreaterThan(1);
    expect(steps[0]!.length).toBeGreaterThan(1);
    const done = (index: number): number => steps[index]!.filter((step) => step.completed).length;
    expect(done(steps.length - 1)).toBeGreaterThan(done(0));

    // And activity is reported when a command *starts*. A long command is silent
    // until it completes, so without this the status could only ever say what the
    // coworker has already finished.
    expect(
      commands.some((event) => event.type === "command" && event.status === "in-progress"),
    ).toBe(true);
  });

  /**
   * A Note the coworker writes into the human's Vault, end to end, against a real
   * engine — and the two mechanisms that answer for it, which are deliberately not the
   * same mechanism.
   *
   * The **engine** has to actually apply a patch outside its working directory when that
   * directory is passed as writable. A fake asserts that by construction; if `exec` ever
   * stops honouring `additionalDirectories`, every Note the coworker tries to write fails
   * and nothing else in this suite would notice.
   *
   * The **record** comes from the Vault's own contents rather than from the event
   * (`vault/snapshot.ts`), which is what lets it catch a Note written by shell
   * redirection and carry what the Note now says. So the classifier is asserted to record
   * *nothing* here — a Vault path is not its business — and the snapshot is asserted to
   * record exactly the one file, once. Two records for one Write is precisely what an
   * audit trail must not do, and with two mechanisms in play that is worth pinning
   * against the real thing.
   */
  it("writes into the Vault outside its workspace, and is recorded once from the Vault", async () => {
    // Outside `$TMPDIR`, or the first half of what this test claims is untestable — a
    // write there succeeds on the temp-directory grant whether `additionalDirectories`
    // works or not. See {@link testTempDir}.
    const vault = path.join(await testTempDir("vault-"), "Notes");
    await mkdir(vault, { recursive: true });
    const before = await snapshotVault(vault);
    const session = engine.startSession({
      workingDirectory: workspace,
      writableDirectories: [vault],
    });

    const writes: Write[] = [];
    const scope = await writeScope({ workspaceDir: workspace, notesDir: vault });
    const changes: EngineEvent[] = [];
    for await (const event of session.run(
      "Using your file-editing tool and not shell redirection, create exactly two files: " +
        `\`${path.join(workspace, "scratch.md")}\` containing the word ONE, and ` +
        `\`${path.join(vault, "note.md")}\` containing the word TWO. Then reply with just DONE.`,
    )) {
      if (event.type === "file-change") changes.push(event);
      writes.push(...writesIn(event, scope));
    }

    expect(changes.length).toBeGreaterThan(0);
    expect(await readFile(path.join(vault, "note.md"), "utf8")).toContain("TWO");
    // Neither file is recorded from the event stream: the scratch file next to its own
    // AGENTS.md is the coworker's own desk, and the Note is the Vault's to answer for.
    expect(writes).toEqual([]);
    // And the Vault answers for it: one change, the Note, with what it now says.
    const vaultChanges = changesBetween(before, await snapshotVault(vault));
    expect(vaultChanges.map((change) => change.path)).toEqual(["note.md"]);
    expect(vaultChanges[0]?.kind).toBe("add");
    expect(vaultChanges[0]?.diff).toContain("TWO");
  });

  /**
   * **Skills are readable and not writable, enforced by the sandbox rather than by asking.**
   *
   * This is the load-bearing fact of build/15 and it can only be measured here. ADR-0004's
   * amendment makes Skills human-authored only, and unlike the Root note there is no
   * injection chokepoint at which the wrapper could enforce that — a Skill is read from
   * disk on demand. So the entire mechanism is that the Skills directory is a sibling of
   * the Notes and appears on no writable list, and the entire question is whether the
   * engine actually honours that.
   *
   * Both routes are checked, because they fail differently and a Job has both: the
   * file-editing tool, and the shell. The shell one is the one that matters — that is the
   * kernel refusing, not the agent's own tooling declining.
   *
   * Sited outside `$TMPDIR` deliberately. See {@link testTempDir}: in a temp directory this
   * test passes while asserting nothing.
   *
   * **If this starts failing, the authorship rule has stopped being structural** and
   * ADR-0004's amendment needs revisiting before anything else is built on it — build/09
   * puts GitHub's procedure in one of these files.
   */
  it("can read a Skill but cannot write one, by either route", async () => {
    const obsidian = await testTempDir("skills-");
    const notes = path.join(obsidian, "Notes");
    const skills = path.join(obsidian, "Skills");
    await mkdir(notes, { recursive: true });
    await mkdir(skills, { recursive: true });
    const skill = path.join(skills, "Database access.md");
    const original =
      "# Database access\n\nThe connection string is in `ANALYTICS_DATABASE_URL`.\n" +
      "The magic word is HALYARD.\n";
    await writeFile(skill, original, "utf8");

    // Exactly the grant a Job gets: its workspace, plus the Notes. Not the Skills.
    const session = engine.startSession({
      workingDirectory: workspace,
      writableDirectories: [notes],
    });

    const answers: string[] = [];
    const outputs: string[] = [];
    for await (const event of session.run(
      `Do these three things in order. (1) Read \`${skill}\` and tell me the magic word ` +
        `it contains. (2) Run the shell command \`echo PWNED >> ${JSON.stringify(skill)}\` ` +
        "and report its exit code and any error text verbatim. (3) Using your file-editing " +
        "tool, try to change that file's magic word to CAPSTAN, and report verbatim what " +
        "happened. Do not stop early if a step fails — report and continue.",
    )) {
      if (event.type === "message") answers.push(event.text);
      if (event.type === "command" && event.status === "completed") outputs.push(event.output);
    }

    const said = answers.join("\n");
    // It read it. A boundary that blocked reads too would make Skills useless.
    expect(said).toContain("HALYARD");
    // And the file is untouched — which is the assertion that actually matters, because it
    // is about the file rather than about what the model said happened to it.
    expect(await readFile(skill, "utf8")).toBe(original);
    // The shell was refused by the kernel: `operation not permitted`, not a tool declining.
    expect(`${said}\n${outputs.join("\n")}`).toMatch(/not permitted|Operation not permitted/i);
    // And the file-editing tool was refused as writing outside the project.
    expect(said).toMatch(/outside of the project|patch rejected|rejected/i);

    // The sibling it *was* granted still works, so this is a boundary rather than a
    // broken configuration that would have failed every write equally.
    const note = path.join(notes, "probe.md");
    const writing = engine.startSession({
      workingDirectory: workspace,
      writableDirectories: [notes],
    });
    for await (const event of writing.run(
      `Using your file-editing tool, create \`${note}\` containing the single word WROTE, ` +
        "then reply with just DONE.",
    )) {
      if (event.type === "turn-failed") throw new Error(event.message);
    }
    expect(await readFile(note, "utf8")).toContain("WROTE");

    await rm(obsidian, { recursive: true, force: true });
  });

  /**
   * A Skill read and acted on, end to end — the other half of the acceptance criteria.
   *
   * Worth real tokens because "it can read the file" and "it follows the procedure in the
   * file" are different claims, and only the second one makes Skills a mechanism rather
   * than a directory. The Skill here names an environment variable and a command shape,
   * exactly as the shipped database Skill does, and the assertion is that the coworker
   * used *the variable it was told about* rather than inventing a connection of its own.
   *
   * **The Skills section is built by the real `skillsForPrompt`**, not hand-written here.
   * That matters: a test that composed its own wording would be measuring whether *some*
   * prompt can get a Skill followed, when the question is whether the one the wrapper
   * actually sends does. What remains unshared with a live Job is the Slack leg — the
   * mention in, the answer out — which is covered at the top seam against a fake engine.
   *
   * No database: the procedure is a shell command that reads an environment variable, so
   * this measures the mechanism without needing a service to be up.
   */
  it("follows a procedure written in a Skill, including the variable it names", async () => {
    const obsidian = await testTempDir("skill-follow-");
    const skills = path.join(obsidian, "Skills");
    await mkdir(skills, { recursive: true });
    await writeFile(
      path.join(skills, "Stock levels.md"),
      [
        "# Stock levels",
        "",
        "How to read current stock levels.",
        "",
        "The inventory file's location is in the environment variable `INVENTORY_PATH`.",
        "Never guess the path; always read the variable.",
        "",
        "Counts are stored as **crates of twelve**, not as units. To report units, multiply",
        "the crate count by 12.",
        "",
        "```sh",
        'cat "$INVENTORY_PATH"',
        "```",
      ].join("\n"),
      "utf8",
    );

    // The data the procedure leads to. 7 crates is 84 units, and 84 is a number that
    // appears nowhere unless the Skill's multiply-by-twelve rule was actually followed.
    const inventory = path.join(obsidian, "inventory.txt");
    await writeFile(inventory, "widgets: 7\n", "utf8");
    // Actually set, in this process's environment, because the engine's subprocess
    // inherits it — which is the mechanism a Skill's "the credential is in this variable"
    // depends on. Telling the coworker about a variable that does not exist would test
    // the prompt rather than the arrangement.
    process.env.INVENTORY_PATH = inventory;

    // App Server is long-lived and inherits the environment at process start. Restart it
    // after setting the fixture variable, as a production restart after editing `.env` would.
    await engine.close();
    engine = await createCodexEngine({ model: "gpt-5.6-sol", reasoningEffort: "low", approvalMode: "off" });

    const session = engine.startSession({
      workingDirectory: workspace,
      writableDirectories: [path.join(obsidian, "Notes")],
    });

    const answers: string[] = [];
    for await (const event of session.run(
      [
        // The wrapper's own words, so this measures the prompt a real Job sends.
        skillsForPrompt(skills, await readSkills(skills)),
        "",
        "How many widgets do we have in stock, in units? Reply with the number and one",
        "sentence saying how you got it.",
      ].join("\n"),
    )) {
      if (event.type === "message") answers.push(event.text);
      if (event.type === "turn-failed") throw new Error(event.message);
    }

    // 84, not 7: the Skill's domain rule was read and applied. This is the whole claim —
    // a coworker that merely read the file would have answered 7.
    expect(answers.at(-1)).toMatch(/84/);

    await rm(obsidian, { recursive: true, force: true });
  });

  /**
   * A real command Write, end to end: a real `git push` into a real repository.
   *
   * The whole reason this is worth tokens is that the *shape* of what the engine
   * reports decided the design. A shell call arrives as
   * `/bin/zsh -lc "git add … && git commit … && git push …"` — the program is behind a
   * quote rather than at the start of the string, and one item carries a whole script —
   * and a table of patterns written against `git push …` on its own would match none of
   * it. A fake cannot tell us that, because a fake says whatever the test says.
   *
   * The remote is a bare repository on disk, so nothing here needs a network or a
   * credential.
   */
  it("recognises a Write in a command the way the engine really reports it", async () => {
    const repo = await mkdtemp(path.join(os.tmpdir(), "open-agent-push-"));
    const remote = path.join(repo, "remote.git");
    const checkout = path.join(repo, "checkout");
    const git = (...args: string[]): Promise<unknown> => promisify(execFile)("git", args);
    await git("init", "--bare", remote);
    await git("init", checkout);
    await git("-C", checkout, "config", "user.email", "coworker@example.com");
    await git("-C", checkout, "config", "user.name", "Coworker");
    // The self-hoster running this may well sign their commits; the agent cannot answer
    // a passphrase prompt, and this test is not about signing.
    await git("-C", checkout, "config", "commit.gpgsign", "false");
    await writeFile(path.join(checkout, "AGENTS.md"), "Answer what you are asked.\n", "utf8");
    await writeFile(path.join(checkout, "README.md"), "one\n", "utf8");
    await git("-C", checkout, "add", ".");
    await git("-C", checkout, "commit", "-m", "first");
    await git("-C", checkout, "remote", "add", "origin", remote);
    const before = await git("-C", remote, "rev-parse", "HEAD");

    const session = engine.startSession({ workingDirectory: checkout });
    const scope = await writeScope({
      workspaceDir: checkout,
      notesDir: path.join(repo, "vault"),
    });
    const writes: Write[] = [];
    const commandEvents: EngineEvent[] = [];
    for await (const event of session.run(
      "Append the word two to README.md, commit it with git, and push it to origin on " +
        "the current branch. Do not use gh. Then reply with just DONE.",
    )) {
      if (event.type === "command") commandEvents.push(event);
      writes.push(...writesIn(event, scope));
    }

    // The push really happened — the bare repository moved on.
    const after = await git("-C", remote, "rev-parse", "HEAD");
    expect(after).not.toEqual(before);
    // And it was recorded as what it was. There may be more than one: the coworker
    // retries, and an attempt that did not obviously succeed is recorded too.
    //
    // Nothing is asserted about the outcome on purpose, and this test is why. The push
    // demonstrably worked — the remote moved — yet it arrives inside a chained command
    // that ends non-zero often enough that "the push succeeded" is not a claim the exit
    // code supports. `Write.failure` says only what is known.
    expect(writes.map((write) => write.action), JSON.stringify(commandEvents)).toContain("Pushed to a git remote");
    // The commit and the edit are not Writes: one is inside the checkout it was given,
    // and the other never left the workspace at all.
    expect(writes.every((write) => write.action === "Pushed to a git remote")).toBe(true);

    await rm(repo, { recursive: true, force: true });
  });

  it("interrupts the active Turn while keeping the supervised server alive", async () => {
    const controller = new AbortController();
    const session = engine.startSession({ workingDirectory: workspace });
    const startedAt = Date.now();
    const run = (async () => {
      for await (const event of session.run(
        "Run the shell command `sleep 120` and then reply with just DONE.",
        { signal: controller.signal },
      )) if (event.type === "command" && event.status === "in-progress") controller.abort();
    })();

    await expect(run).rejects.toThrow();
    expect(Date.now() - startedAt).toBeLessThan(30_000);

    const answers: string[] = [];
    for await (const event of engine.startSession({ workingDirectory: workspace }).run(
      "Reply with exactly ALIVE. Do not run commands.",
    )) if (event.type === "message") answers.push(event.text);
    expect(answers.at(-1)).toContain("ALIVE");
  });

  it("translates a command execution, including its output and exit code", async () => {
    const session = engine.startSession({ workingDirectory: workspace });

    const events: EngineEvent[] = [];
    for await (const event of session.run(
      "Run the shell command `echo open-agent-contract` and tell me its output.",
    )) {
      events.push(event);
    }

    const commands = events.flatMap((event) => (event.type === "command" ? [event] : []));
    expect(commands.length).toBeGreaterThan(0);
    const finished = commands.filter((command) => command.status === "completed");
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.map((command) => command.output).join("\n")).toContain(
      "open-agent-contract",
    );
    expect(finished.every((command) => command.exitCode === 0)).toBe(true);
  });
});
