import { RECORDED_CODEX_VERSION } from "../../src/config.ts";
import type { MentionFile } from "../../src/files/types.ts";
import type { Clock, Stoppable } from "../../src/ports/clock.ts";
import type {
  Engine,
  EngineEvent,
  EngineSession,
  RunOptions,
  SandboxPosture,
  SessionOptions,
} from "../../src/ports/engine.ts";
import type { McpInventory, McpInventoryProber, McpServerConfig } from "../../src/ports/mcp.ts";
import type {
  BranchProtection,
  RepositoryProtectionProbe,
} from "../../src/ports/repositories.ts";
import type {
  DownloadFile,
  DownloadedFile,
  PostMessage,
  PostTopLevelMessage,
  PostedMessage,
  ReadThread,
  SetStatus,
  SlackClient,
  SlackIdentity,
  SlackChannel,
  SlackThreadHistory,
  SlackThreadMessage,
  UpdateMessage,
  UploadedFile,
  UploadFile,
  ApprovalPost,
  ApprovalPresentation,
  SettleApproval,
  EphemeralMessage,
} from "../../src/ports/slack.ts";
import type { Thread } from "../../src/thread.ts";

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** One text Slack was asked to show, whether it arrived by posting or by editing. */
export interface SlackWrite {
  kind: "post" | "edit";
  ts: string;
  thread: Thread;
  text: string;
  /** When it landed, by the injected clock — so a test can assert on cadence. */
  at: number;
}

export interface StatusCall {
  thread: Thread;
  status: string;
  at: number;
}

export interface FileUploadCall extends UploadFile {
  at: number;
}

export class FakeSlack implements SlackClient {
  readonly approvalPosts: ApprovalPresentation[] = [];
  readonly approvalSettlements: SettleApproval[] = [];
  readonly ephemeralPosts: EphemeralMessage[] = [];
  /** Every text Slack was asked to show, posts and edits together, in order. */
  readonly writes: SlackWrite[] = [];
  /** Set to make `auth.test` fail, as a revoked or mistyped bot token would. */
  failIdentity: Error | undefined;
  /** Every edit *attempted*, including the ones that failed, stamped by the clock. */
  readonly editAttempts: (UpdateMessage & { at: number })[] = [];
  /** Every call to Slack's own status indicator. An empty status clears it. */
  readonly statuses: StatusCall[] = [];
  /** Private Slack URLs this fake can serve, by exact address. */
  readonly downloadableFiles = new Map<string, DownloadedFile>();
  readonly downloadAttempts: DownloadFile[] = [];
  /** Files Slack history says were shared earlier in a Thread. */
  readonly threadFilesByThread = new Map<string, MentionFile[]>();
  /** Messages Slack history says were posted in a Thread. */
  readonly threadMessagesByThread = new Map<string, SlackThreadMessage[]>();
  readonly threadQueries: ReadThread[] = [];
  /** Every result artifact shared into Slack. */
  readonly uploads: FileUploadCall[] = [];
  /** Set to make the next `postMessage` fail, as a Slack outage would. */
  failNextPost: Error | undefined;
  /** Set to make every edit fail, as a rate limit or a deleted message would. */
  failEdits: Error | undefined;
  /** Set to make the indicator fail, as an app predating the scope change would. */
  failStatuses: Error | undefined;
  /** Set to make every result-file upload fail. */
  failUploads: Error | undefined;
  readonly userTimezones = new Map<string, string>();
  readonly channels = new Map<string, SlackChannel>();
  readonly topLevelPosts: (PostTopLevelMessage & { ts: string; at: number })[] = [];

  private nextTs = 1;
  private readonly clock: Clock;
  private readonly heldEdits = new Map<string, { open: Deferred<void>; attempted: Deferred<void> }>();

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /**
   * Make edits to one message hang until released.
   *
   * Slack round-trips take real time, and a few of this system's sharper edges live
   * *inside* one — the moment a queued Job has been handed its Thread and is waiting
   * for Slack to accept its first status write, having done nothing else yet. This is
   * how a test stands in that moment deliberately rather than by racing for it.
   */
  holdEditsTo(ts: string): { attempted: Promise<void>; release: () => void } {
    const held = { open: deferred(), attempted: deferred() };
    this.heldEdits.set(ts, held);
    return {
      attempted: held.attempted.promise,
      release: () => {
        this.heldEdits.delete(ts);
        held.open.resolve();
      },
    };
  }

  async identity(): Promise<SlackIdentity> {
    if (this.failIdentity) throw this.failIdentity;
    return { botUserId: "U0COWORKER", team: "A Test Workspace" };
  }

  async userTimezone(userId: string): Promise<string | undefined> {
    return this.userTimezones.get(userId);
  }

  async resolveWritableChannel(reference: string): Promise<SlackChannel> {
    const mentioned = /^<#([A-Z0-9]+)(?:\|[^>]+)?>$/.exec(reference.trim());
    const normalized = mentioned?.[1] ?? reference.replace(/^#/, "");
    const matches = [...this.channels.values()].filter((channel) => channel.id === normalized || channel.name === normalized);
    if (matches.length !== 1) throw new Error(`I cannot resolve ${reference} to one writable channel.`);
    return { ...matches[0]! };
  }

  async postTopLevelMessage(message: PostTopLevelMessage): Promise<PostedMessage> {
    const failure = this.failNextPost;
    if (failure) {
      this.failNextPost = undefined;
      throw failure;
    }
    const ts = `top-${this.nextTs++}`;
    this.topLevelPosts.push({ ...message, ts, at: this.clock.now() });
    return { ts };
  }

  async downloadFile(file: DownloadFile): Promise<DownloadedFile> {
    this.downloadAttempts.push(file);
    const found = this.downloadableFiles.get(file.url);
    if (found === undefined) throw new Error(`No fake Slack file exists at ${file.url}`);
    return found;
  }

  async readThread(query: ReadThread): Promise<SlackThreadHistory> {
    this.threadQueries.push(query);
    return {
      files: this.threadFilesByThread.get(query.thread.ts) ?? [],
      messages: this.threadMessagesByThread.get(query.thread.ts) ?? [],
    };
  }

  async uploadFile(file: UploadFile): Promise<UploadedFile> {
    if (this.failUploads) throw this.failUploads;
    this.uploads.push({ ...file, at: this.clock.now() });
    return { permalink: `https://test.slack.com/files/${encodeURIComponent(file.filename)}` };
  }

  async postMessage(message: PostMessage): Promise<PostedMessage> {
    const failure = this.failNextPost;
    if (failure) {
      this.failNextPost = undefined;
      throw failure;
    }
    const ts = `post-${this.nextTs++}`;
    this.record("post", ts, message.thread, message.text);
    return { ts };
  }

  async postApproval(message: ApprovalPost): Promise<PostedMessage> {
    const ts = `post-${this.nextTs++}`;
    this.approvalPosts.push({ ...message, actions: [
      { actionId: "approval_approve_once", label: "Approve once", value: message.requestId, style: "primary" },
      { actionId: "approval_allow_similar", label: "Allow similar in this Thread", value: message.requestId },
      { actionId: "approval_deny", label: "Deny", value: message.requestId, style: "danger" },
    ] });
    this.record("post", ts, message.thread, `Approval required: ${message.target}`);
    return { ts };
  }

  async settleApproval(message: SettleApproval): Promise<void> { this.approvalSettlements.push(message); this.record("edit", message.ts, message.thread, message.text); }
  async postEphemeral(message: EphemeralMessage): Promise<void> { this.ephemeralPosts.push(message); }

  async updateMessage(message: UpdateMessage): Promise<void> {
    this.editAttempts.push({ ...message, at: this.clock.now() });
    const held = this.heldEdits.get(message.ts);
    if (held) {
      held.attempted.resolve();
      await held.open.promise;
    }
    if (this.failEdits) throw this.failEdits;
    if (!this.writes.some((write) => write.ts === message.ts)) {
      throw new Error(`Asked to edit ${message.ts}, which this Slack never posted`);
    }
    this.record("edit", message.ts, message.thread, message.text);
  }

  async setStatus(status: SetStatus): Promise<void> {
    if (this.failStatuses) throw this.failStatuses;
    this.statuses.push({ thread: status.thread, status: status.status, at: this.clock.now() });
  }

  /** Every message posted, in order, as it was posted. */
  get posts(): PostMessage[] {
    return this.writes
      .filter((write) => write.kind === "post")
      .map((write) => ({ thread: write.thread, text: write.text }));
  }

  /** The messages *posted* into one Thread, oldest first — not counting later edits. */
  textsIn(threadTs: string): string[] {
    return this.posts.filter((post) => post.thread.ts === threadTs).map((post) => post.text);
  }

  /** The `ts` Slack handed back for the nth posted message. */
  tsOf(post: number): string {
    const ts = this.writes.filter((write) => write.kind === "post")[post]?.ts;
    if (ts === undefined) throw new Error(`This Slack never posted a message ${post}`);
    return ts;
  }

  /** Every version one message has had, oldest first — the post, then each edit. */
  versionsOf(ts: string): string[] {
    return this.writes.filter((write) => write.ts === ts).map((write) => write.text);
  }

  /** What one message says now, after every edit that has landed. */
  currentTextOf(ts: string): string {
    return this.versionsOf(ts).at(-1) ?? "";
  }

  /** When each of those versions landed, so a test can assert on refresh cadence. */
  timesOf(ts: string): number[] {
    return this.writes.filter((write) => write.ts === ts).map((write) => write.at);
  }

  get edits(): SlackWrite[] {
    return this.writes.filter((write) => write.kind === "edit");
  }

  private record(kind: SlackWrite["kind"], ts: string, thread: Thread, text: string): void {
    this.writes.push({ kind, ts, thread, text, at: this.clock.now() });
  }
}

/** What the fake engine does for one Turn. */
export type EngineScript = (context: {
  prompt: string;
  /** Which Session the Turn is running in, so a script can answer per-Thread. */
  sessionId: string;
  /**
   * The Job's workspace, as the real engine is given it — so a script can write to
   * the coworker's own desk rather than only to somewhere outside it.
   */
  workingDirectory: string;
  requestApproval: (action: import("../../src/ports/engine.ts").PlannedAction) => Promise<"allow" | "deny">;
}) => AsyncIterable<EngineEvent> | Iterable<EngineEvent> | Promise<Iterable<EngineEvent>>;

/** One Turn the fake engine was asked to run. */
export interface FakeTurn {
  prompt: string;
  /** Local images attached to this Turn through the engine's visual-input channel. */
  imagePaths: readonly string[];
  /** The Session it ran in — the same value a real Codex would report as its id. */
  sessionId: string;
  /**
   * The run was killed rather than left to finish.
   *
   * A fake cannot die, so this is what standing in for "the subprocess actually
   * died" looks like at this seam: the engine was told to stop and stopped. That the
   * real one really dies is the contract test's job.
   */
  aborted: boolean;
}

export class FakeEngine implements Engine {
  /** Every Turn of work run, in order. The Librarian's passes are not among them. */
  readonly ranTurns: FakeTurn[] = [];
  readonly startedSessions: SessionOptions[] = [];
  /** Every resume attempt, in order — a real Codex reads these off its own disk. */
  readonly resumedSessions: { sessionId: string; options: SessionOptions }[] = [];
  /**
   * The Librarian's closing passes, kept apart from the Turns of work.
   *
   * Apart because the two are different questions a test asks — "how many Jobs ran" and
   * "how many curation passes ran" — and because a Job gains one of each, so counting
   * them together would make every assertion about Jobs arithmetic about the Librarian.
   */
  readonly oneOffTurns: FakeTurn[] = [];
  versionToReport = RECORDED_CODEX_VERSION;
  /** What the real adapter configures, restated so the startup report has something true. */
  sandbox: SandboxPosture = {
    mode: "read-only",
    networkEnabled: false,
    execPolicy: "every capability expansion is intercepted",
  };

  /** Replaced per test to script what the engine does. */
  script: EngineScript = () => [{ type: "message", text: "Done." } as const];

  /**
   * And what it does for the Librarian's pass, which by default is nothing.
   *
   * Nothing is the honest default: most Jobs are worth no Note, so a fake that filed
   * something after every Job would make the common case the untested one — and it would
   * put a Write record into the Thread of every test that only ever wanted an answer.
   */
  librarianScript: EngineScript = () => [
    { type: "message", text: "Nothing here worth remembering." } as const,
  ];

  private nextSession = 1;
  private readonly waiting: { count: number; resolve: () => void }[] = [];

  async version(): Promise<string> {
    return this.versionToReport;
  }

  async close(): Promise<void> {}

  /**
   * Resolves once `count` Turns have been asked for.
   *
   * A Job is acknowledged in the Thread well before it reaches the engine — there is a
   * workspace to prepare and a Session to open first — so "the Job is running" is not
   * the same moment as "the mention was accepted". A test that stops a Job, or winds
   * the clock past a Turn's deadline, has to wait for this or it is acting on a Job
   * that has not started.
   */
  started(count = 1): Promise<void> {
    if (this.ranTurns.length >= count) return Promise.resolve();
    const waiter = deferred();
    this.waiting.push({ count, resolve: waiter.resolve });
    return waiter.promise;
  }

  startSession(options: SessionOptions): EngineSession {
    this.startedSessions.push(options);
    return this.session(`session-${this.nextSession++}`, false, options);
  }

  /** A Session nobody resumes: the Librarian's pass, on its own script. */
  startOneOffSession(options: SessionOptions): EngineSession {
    return this.session(`one-off-${this.nextSession++}`, false, options, {
      script: this.librarianScript,
      into: this.oneOffTurns,
    });
  }

  /** The prompts of the Librarian's passes, in order. */
  get librarianPrompts(): string[] {
    return this.oneOffTurns.map((turn) => turn.prompt);
  }

  /**
   * A fresh instance of this class models a restarted process, so a Session started
   * before the restart still resumes here — which is what a real Codex does, because
   * the conversation is on its disk rather than in this process.
   */
  resumeSession(sessionId: string, options: SessionOptions): EngineSession {
    this.resumedSessions.push({ sessionId, options });
    return this.session(sessionId, true, options);
  }

  private session(
    sessionId: string,
    resumed: boolean,
    options: SessionOptions,
    kind: { script: EngineScript; into: FakeTurn[] } = { script: this.script, into: this.ranTurns },
  ): EngineSession {
    const engine = this;
    // A real Session has no id until a Turn starts; a resumed one knows it up front.
    let id: string | null = resumed ? sessionId : null;
    return {
      get id() {
        return id;
      },
      run(prompt: string, runOptions?: RunOptions): AsyncIterable<EngineEvent> {
        const turn: FakeTurn = {
          prompt,
          sessionId,
          imagePaths: runOptions?.imagePaths ?? [],
          aborted: false,
        };
        kind.into.push(turn);
        engine.settleWaiters();
        id = sessionId;
        return (async function* () {
          // The bounds' whole promise is that a Job which has been stopped stops
          // *now* — not once whatever it was doing gets around to finishing. So the
          // abort races every step, including the script's own first await: a script
          // that never resolves is exactly the wedged engine a timeout exists for.
          const killed = abortWhen(runOptions?.signal, () => {
            turn.aborted = true;
          });
          try {
            yield { type: "session-started", sessionId } as const;
            yield { type: "turn-started" } as const;
            const scripted = await Promise.race([
              Promise.resolve(
                kind.script({
                  prompt,
                  sessionId,
                  workingDirectory: options.workingDirectory,
                  requestApproval: async (action) => runOptions?.onApproval?.(action) ?? "allow",
                }),
              ),
              killed.rejected,
            ]);
            const events = iterate(scripted);
            /**
             * A script that runs to its end is a Turn that ran to its end, and a real
             * engine says so — `codex exec` emits `turn.completed` on the way out. It
             * matters because the wrapper reads the *absence* of that event as "this
             * Turn was interrupted", so a fake that never sent one would make every
             * Job look like a crash. A script that ends in `turn-failed` gets nothing
             * appended: that Turn genuinely did not complete.
             */
            let ended = false;
            for (;;) {
              const next = await Promise.race([
                Promise.resolve(events.next()),
                killed.rejected,
              ]);
              if (next.done === true) break;
              ended = next.value.type === "turn-completed" || next.value.type === "turn-failed";
              yield next.value;
            }
            if (!ended) yield { type: "turn-completed", usage: undefined } as const;
          } finally {
            killed.release();
          }
        })();
      },
    };
  }

  /** The prompts of every Turn run, in order. */
  get turns(): string[] {
    return this.ranTurns.map((turn) => turn.prompt);
  }

  /** The prompt the engine received for a given Turn, for assertions. */
  promptFor(turn: number): string {
    return this.turnAt(turn).prompt;
  }

  /** Which Session a given Turn ran in, for asserting Thread isolation. */
  sessionFor(turn: number): string {
    return this.turnAt(turn).sessionId;
  }

  private settleWaiters(): void {
    for (const waiter of this.waiting.splice(0)) {
      if (this.ranTurns.length >= waiter.count) waiter.resolve();
      else this.waiting.push(waiter);
    }
  }

  private turnAt(turn: number): FakeTurn {
    const ran = this.ranTurns[turn];
    if (ran === undefined) throw new Error(`The fake engine never ran turn ${turn}`);
    return ran;
  }
}

/** Both shapes an engine script may be written in, iterated the same way. */
function iterate(
  source: AsyncIterable<EngineEvent> | Iterable<EngineEvent>,
): AsyncIterator<EngineEvent> | Iterator<EngineEvent> {
  return Symbol.asyncIterator in source
    ? source[Symbol.asyncIterator]()
    : source[Symbol.iterator]();
}

/**
 * A promise that rejects the moment the signal fires, and never otherwise.
 *
 * Raced against each step of a run so that a stop is felt immediately. The handler
 * attached to it is not decoration: a race the abort loses would otherwise leave a
 * rejected promise nobody handled, and vitest fails the whole file on one of those.
 */
function abortWhen(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): { rejected: Promise<never>; release: () => void } {
  if (!signal) return { rejected: new Promise<never>(() => {}), release: () => {} };

  let listener = (): void => {};
  const rejected = new Promise<never>((_resolve, reject) => {
    listener = () => {
      onAbort();
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal.aborted) listener();
    else signal.addEventListener("abort", listener, { once: true });
  });
  rejected.catch(() => {});

  return { rejected, release: () => signal.removeEventListener("abort", listener) };
}

interface FakeTimer {
  intervalMs: number;
  tick: () => void | Promise<void>;
  dueAt: number;
  stopped: boolean;
  /** A deadline rather than a cadence: it fires once and is done. */
  once: boolean;
}

export class FakeClock implements Clock {
  private current: number;
  private readonly timers: FakeTimer[] = [];

  constructor(startingAt = 1_700_000_000_000) {
    this.current = startingAt;
  }

  now(): number {
    return this.current;
  }

  every(intervalMs: number, tick: () => void | Promise<void>): Stoppable {
    return this.schedule(intervalMs, tick, false);
  }

  after(delayMs: number, tick: () => void | Promise<void>): Stoppable {
    return this.schedule(delayMs, tick, true);
  }

  /**
   * Move time forward, running everything that comes due on the way — and awaiting
   * it, so that "ten silent minutes passed" is a thing a test can assert after.
   */
  async advance(ms: number): Promise<void> {
    const until = this.current + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => !timer.stopped && timer.dueAt <= until)
        .sort((left, right) => left.dueAt - right.dueAt)[0];
      if (due === undefined) break;
      this.current = due.dueAt;
      if (due.once) due.stopped = true;
      else due.dueAt += due.intervalMs;
      await due.tick();
    }
    this.current = until;
  }

  private schedule(
    intervalMs: number,
    tick: () => void | Promise<void>,
    once: boolean,
  ): Stoppable {
    const timer: FakeTimer = {
      intervalMs,
      tick,
      dueAt: this.current + intervalMs,
      stopped: false,
      once,
    };
    this.timers.push(timer);
    return {
      stop: () => {
        timer.stopped = true;
      },
    };
  }
}

export class FakeInventoryProber implements McpInventoryProber {
  inventories = new Map<string, McpInventory>();
  /** Set to make probing fail, as an unreachable or unauthorised server would. */
  failure: Error | undefined;
  /** Every server probed, in order — so a test can assert that one was not. */
  readonly probed: string[] = [];

  async probe(server: McpServerConfig): Promise<McpInventory> {
    this.probed.push(server.name);
    if (this.failure) throw this.failure;
    return this.inventories.get(server.name) ?? { tools: [] };
  }
}

export class FakeRepositoryProtectionProbe implements RepositoryProtectionProbe {
  protections = new Map<string, BranchProtection>();
  readonly checked: string[] = [];

  async check(repository: string): Promise<BranchProtection> {
    this.checked.push(repository);
    return (
      this.protections.get(repository) ?? {
        status: "protected",
        defaultBranch: "main",
      }
    );
  }
}
