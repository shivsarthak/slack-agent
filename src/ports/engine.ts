/**
 * The engine seam retained by ADR-0008.
 *
 * Everything below is the *wrapper's* vocabulary. No Codex type appears here, and
 * no module outside `src/engine/` knows Codex App Server protocol types. The
 * transport, process lifecycle, and JSON-RPC variants remain a bounded adapter detail.
 */

export type ActivityStatus = "in-progress" | "completed" | "failed";

export interface PlanStep {
  text: string;
  completed: boolean;
}

export interface FileChange {
  path: string;
  kind: "add" | "delete" | "update";
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

export type ActionSource = "command" | "file-change" | "permission" | "mcp";
export type ActionEffect = "read" | "local-mutation" | "external-mutation" | "consequential" | "unknown";

export interface ActionTarget {
  service: string;
  resource: string;
  environment: string;
}

/** One exact operation held by the engine before it executes. */
export interface PlannedAction {
  id: string;
  source: ActionSource;
  operation: string;
  target: ActionTarget;
  arguments: unknown;
  workingDirectory?: string | undefined;
  preview: string;
  effect: ActionEffect;
  risk: string;
  grantScope: string;
}

/** Trusted authorization supplied by the wrapper, never inferred from tool output. */
export interface GoalContext {
  request: string;
  trustedHumanMessages: readonly string[];
  threadKey: string;
  requesterUserId: string;
  workspaceDirectory: string;
}

export type ApprovalHandler = (action: PlannedAction, engineSignal?: AbortSignal) => Promise<"allow" | "deny">;

/**
 * What the engine did, in terms the rest of the system understands.
 *
 * Progress remains item-level so the Slack reporter does not inherit token-delta churn.
 * The App Server adapter translates only stable item and plan notifications.
 */
export type EngineEvent =
  | { type: "session-started"; sessionId: string }
  | { type: "turn-started" }
  | { type: "message"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "plan"; steps: PlanStep[] }
  | {
      type: "command";
      command: string;
      status: ActivityStatus;
      output: string;
      exitCode: number | undefined;
    }
  | { type: "file-change"; changes: FileChange[]; status: ActivityStatus }
  | {
      type: "tool-call";
      server: string;
      tool: string;
      status: ActivityStatus;
      error: string | undefined;
      /**
       * What the server sent back, as text.
       *
       * Carried because a Write's audit record has to name the thing that was written
       * and link to it, and the identifier of a freshly-created ticket or pull request
       * exists nowhere else — the arguments say what was asked for, and only the result
       * says what came into being.
       */
      result: string | undefined;
    }
  | { type: "web-search"; query: string }
  | { type: "turn-completed"; usage: TokenUsage | undefined }
  | { type: "turn-failed"; message: string }
  | { type: "engine-error"; message: string };

export interface SessionOptions {
  /**
   * The Job's workspace: the sandbox's writable root, and where the engine looks
   * for its operating manual.
   */
  workingDirectory: string;
  /** Additional directories the engine may write to — the Vault, once it exists. */
  writableDirectories?: readonly string[];
}

export interface RunOptions {
  /**
   * Local images that must be attached as visual inputs, not merely named in the text
   * prompt. The Codex adapter translates these to SDK `local_image` entries.
   */
  imagePaths?: readonly string[] | undefined;
  /**
   * Stop the Turn, killing the engine's process.
   *
   * The engine offers no ceiling of its own — no timeout, no max-Turns, no budget,
   * no kill switch — so every bound in this system is the wrapper's, and this is the
   * one primitive all of them are built on. Aborting must actually terminate the
   * subprocess rather than merely stopping the wrapper reading from it: a Job that
   * has been stopped and is still spending money has not been stopped.
   *
   * The iteration throws when this fires. Whoever aborted knows why, and that reason
   * is better than the one the abort carries.
   */
  signal?: AbortSignal | undefined;
  /** Called synchronously with execution: the action remains pending until it resolves. */
  onApproval?: ApprovalHandler | undefined;
}

/** One Session — the coworker's accumulated understanding of one Thread. */
export interface EngineSession {
  /** The engine's own identifier for this Session. Populated once a Turn starts. */
  readonly id: string | null;
  /** Run one Turn, streaming what happens as it happens. */
  run(prompt: string, options?: RunOptions): AsyncIterable<EngineEvent>;
}

/**
 * The sandbox the engine puts a Job in, as the engine itself has configured it.
 *
 * Reported at startup rather than restated in documentation, and read from the adapter
 * rather than from configuration, because these three values *are* layer 2 of the action
 * boundary for everything the coworker reaches by shell. A self-hoster who has read
 * ADR-0002 and wants to know whether their instance actually runs that way should be able
 * to see it in the startup output, from the module that decided it.
 */
export interface SandboxPosture {
  /** Codex's own word: `workspace-write`, and not `danger-full-access`. */
  mode: string;
  /** On, because the work is GitHub, Linear, and the web. */
  networkEnabled: boolean;
  /**
   * Which commands the engine may run. `unrestricted` in v1 — once the credential is the
   * boundary, per-command rules buy little and cost a lot of tuning.
   */
  execPolicy: string;
}

export interface Engine {
  /** The installed engine version, reported at startup. */
  version(): Promise<string>;
  /** How the engine sandboxes a Job. Reported at startup; see {@link SandboxPosture}. */
  readonly sandbox: SandboxPosture;
  startSession(options: SessionOptions): EngineSession;
  /**
   * A Session nobody will ever resume: one prompt, one answer, no identity kept.
   *
   * The Librarian's closing pass is this. It is deliberately *not* a Turn in the
   * Thread's own Session — the spec has it handed the Job's transcript, which is only
   * necessary because it does not share the conversation, and that is the point: a pass
   * that lived in the Thread's Session would leave its bookkeeping in the context every
   * future Job in that Thread resumes into.
   *
   * Separate from {@link startSession} because the *wrapper* treats the two differently
   * — one identifier is written to the Session store and the other is thrown away — and
   * a caller that cannot tell them apart is a caller that can accidentally persist the
   * wrong one.
   */
  startOneOffSession(options: SessionOptions): EngineSession;
  /**
   * Pick a Session back up where it left off.
   *
   * `sessionId` is what a previous Session reported as its own `id`. The engine holds
   * the conversation, so nothing about the Thread's history is passed back in — which
   * is the whole reason the wrapper's only durable state is the identifier.
   *
   * Durability is turn-granular: a Session resumes from its last *completed* Turn.
   */
  resumeSession(sessionId: string, options: SessionOptions): EngineSession;
  /** Stop the supervised engine process and invalidate every active Turn/request. */
  close(): Promise<void>;
}
