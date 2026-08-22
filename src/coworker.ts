import type { Config } from "./config.ts";
import { reasonFor } from "./failure.ts";
import { prepareOutputDirectory, shareResultFiles } from "./files/egress.ts";
import { ingestMentionFiles, isVisualInput, supportsMentionFile } from "./files/ingress.ts";
import type { IngestedFile, MentionFile } from "./files/types.ts";
import { boundJob, type JobBounds, type StopReason } from "./jobs/bounds.ts";
import { trackTurnDurability } from "./jobs/interruption.ts";
import { buildJobPrompt } from "./jobs/prompt.ts";
import { createJobQueue, type JobQueue, type Place, type WaitReason } from "./jobs/queue.ts";
import { droppedReceipt, queueReceipt, stopReply } from "./jobs/replies.ts";
import { reportFor, stopSentence, type JobReport } from "./jobs/report.ts";
import { isStopRequest } from "./jobs/request.ts";
import { recordTranscript } from "./jobs/transcript.ts";
import type { Clock } from "./ports/clock.ts";
import type { Engine, EngineSession, PlanStep, SessionOptions } from "./ports/engine.ts";
import type { Logger } from "./ports/log.ts";
import type { McpInventoryProber } from "./ports/mcp.ts";
import type { RepositoryProtectionProbe } from "./ports/repositories.ts";
import type { SessionRecord, SessionStore } from "./ports/sessions.ts";
import type { SlackClient } from "./ports/slack.ts";
import { runPreflight } from "./preflight/run.ts";
import { startAuditTrail, type AuditTrail } from "./reporter/audit.ts";
import { startJobStatus, type JobStatus } from "./reporter/status.ts";
import { threadKey, type Thread } from "./thread.ts";
import { openVaultChangeLog, vaultChangeLogFile, type VaultChangeLog } from "./vault/change-log.ts";
import { runLibrarianPass } from "./vault/librarian.ts";
import { NO_ROOT_NOTE, readRootNote, rootNoteConcerns, type RootNote } from "./vault/root.ts";
import { readSkills } from "./vault/skills.ts";
import {
  openVaultWindow,
  trackVaultWindows,
  type VaultWindow,
  type VaultWindows,
} from "./vault/window.ts";
import { prepareWorkspace, workspaceDirectory } from "./workspace.ts";
import { startWorkspaceLifecycle, type WorkspaceLifecycle } from "./workspaces/lifecycle.ts";
import { writeScope } from "./writes/classify.ts";
import {
  createApprovalCoordinator,
  type ApprovalClick,
  type ApprovalClickResult,
} from "./approvals/coordinator.ts";
import { approvalStoreFile, openApprovalStore } from "./approvals/store.ts";
import { createContextualReviewer } from "./approvals/reviewer.ts";
import type { ContextualReviewer } from "./approvals/policy.ts";
import type { Tenant } from "./tenant.ts";

/**
 * The gate fails closed when the reviewer breaks, which is right — but silently,
 * which is not: an operator staring at an unexplained "ask (unknown)" needs the
 * reviewer's actual failure in the log to have any chance of fixing it.
 */
function loggedReviewer(reviewer: ContextualReviewer, log: Logger): ContextualReviewer {
  return {
    async review(input) {
      try {
        const decision = await reviewer.review(input);
        log.info(`Contextual reviewer decided ${decision.decision}: ${decision.rationale}`);
        return decision;
      } catch (error) {
        log.warn(`Contextual reviewer failed; the gate fails closed to ask: ${reasonFor(error)}`);
        throw error;
      }
    },
  };
}

/** A human addressing the coworker with a task, in the wrapper's own terms. */
export interface Mention {
  /** Slack's `event_id`. This is the Job's identity, and how a redelivery is caught. */
  eventId: string;
  thread: Thread;
  /** The message that triggered this Job, distinct from the Thread's root timestamp. */
  messageTs: string;
  userId: string;
  text: string;
  files: readonly MentionFile[];
}

/** A Job that has started. It runs long after the mention has been acknowledged. */
export interface StartedJob {
  jobId: string;
  /** Resolves when the Job has reported back into the Thread. */
  completed: Promise<void>;
}

export type JobCompletion = "succeeded" | "failed" | "timed-out";

export interface ScheduledRequest {
  occurrenceId: string;
  scheduleId: string;
  thread: Thread;
  creatorUserId: string;
  task: string;
  dueAt: string;
  startedAt: string;
  timezone: string;
  previousSuccessAt: string | null;
}

export interface ScheduledJob {
  jobId: string;
  completed: Promise<JobCompletion>;
}

export interface CoworkerDeps {
  tenant: Tenant;
  config: Config;
  slack: SlackClient;
  engine: Engine;
  clock: Clock;
  /** The `thread_ts → session id` mapping. The durable state owned by the Job runner. */
  sessions: SessionStore;
  inventoryProber: McpInventoryProber;
  repositoryProtection: RepositoryProtectionProbe;
  log: Logger;
  /**
   * Where named credentials are read from — the one store, shared with whatever was
   * constructed from it. Injected so a test's startup checks do not depend on the shell that
   * ran them.
   */
  env: NodeJS.ProcessEnv;
  /** Test transport override; production repositories use their canonical GitHub HTTPS URL. */
  repositoryRemote?: ((repository: string) => string) | undefined;
}

export interface Coworker {
  readonly tenant: Tenant;
  /** Checked before the first mention is accepted, so surprises surface at startup. */
  preflight(): Promise<void>;
  /**
   * Acknowledge a mention and start its Job. Returns once the acknowledgement is in
   * the Thread — the Job itself is still running.
   */
  handleMention(mention: Mention): Promise<StartedJob>;
  /** Submit a claimed Schedule Occurrence through the ordinary Job pipeline. */
  handleScheduled(request: ScheduledRequest): Promise<ScheduledJob>;
  handleApproval(click: ApprovalClick): Promise<ApprovalClickResult>;
}

export function createCoworker(deps: CoworkerDeps): Coworker {
  const approvals = openApprovalStore({
    filePath: approvalStoreFile(deps.config.stateDir),
  }).then((store) =>
    createApprovalCoordinator({
      config: deps.config.approvals,
      slack: deps.slack,
      store,
      clock: deps.clock,
      log: deps.log,
      ...(deps.config.approvals.policy
        ? {
            reviewer: loggedReviewer(
              createContextualReviewer({
                engine: deps.engine,
                clock: deps.clock,
              }),
              deps.log,
            ),
          }
        : {}),
    }),
  );
  /**
   * The Jobs running right now, by Thread — the whole of what a hard-stop needs.
   *
   * Held in memory rather than on disk on purpose: a Job cannot outlive the process
   * that is streaming its subprocess, so an entry here that survived a restart would
   * name a Job that is already dead. The Session mapping is the only thing that
   * genuinely has to persist.
   *
   * At most one per Thread, and the queue is what makes that true.
   */
  const running = new Map<string, JobBounds>();
  const queue = createJobQueue({
    maxConcurrentJobs: deps.config.bounds.maxConcurrentJobs,
  });
  /**
   * Which Jobs have the Vault open right now.
   *
   * There is one Vault and several concurrent Jobs, and the filesystem cannot say which of
   * them wrote a file. This is how a Job finds out that it cannot claim what it saw — see
   * `vault/window.ts`, which is where the consequence is spelled out.
   */
  const vaultWindows: VaultWindows = trackVaultWindows();
  const vaultChangeLog = openVaultChangeLog({
    filePath: vaultChangeLogFile(deps.config.stateDir),
    clock: deps.clock,
    log: deps.log,
  });
  const workspaceLifecycle = startWorkspaceLifecycle({
    workspaceRoot: deps.config.workspaceRoot,
    stateDir: deps.config.stateDir,
    inactivityMs: deps.config.workspaceRetention.inactivityMs,
    clock: deps.clock,
    log: deps.log,
  });

  return {
    tenant: deps.tenant,
    handleApproval: async (click) => (await approvals).decide(click),
    preflight: async () => {
      await runPreflight(deps);
      // Reclaiming years of old workspaces can take minutes. It is housekeeping, not a
      // condition for serving Slack, so startup must not wait for it. The lifecycle's Job
      // leases still serialize a Job against any sweep already touching its workspace.
      void workspaceLifecycle.sweep().catch((error: unknown) => {
        deps.log.warn(`Initial workspace sweep failed: ${reasonFor(error)}`);
      });
    },

    async handleMention(mention: Mention): Promise<StartedJob> {
      // Checked before anything else is posted, and before any place in the queue is
      // taken: a stop is not a task, it must not wait behind the Job it is meant to
      // kill, and giving it a status message would leave an "On it" hanging over a
      // Thread where the answer is that something has ended.
      if (isStopRequest(mention.text)) {
        return {
          jobId: mention.eventId,
          completed: Promise.all([
            hardStop(deps, running, queue, mention),
            approvals.then((coordinator) => coordinator.cancelThread(threadKey(mention.thread))),
          ]).then(() => undefined),
        };
      }

      // Taken before the acknowledgement is posted, and synchronously: the promise is
      // that queued mentions are answered in the order they arrived, and a place taken
      // after an `await` would be a place in the order Slack's replies came back.
      const place = queue.join(mention.thread);

      // Acknowledged before any work starts. Bolt has already ack'd the socket event,
      // but the human needs to see their request land in the Thread — that is what
      // makes closing the laptop reasonable, and it is the whole difference between a
      // queued message and a dropped one.
      //
      // Either way it is **one** message, which the Job then owns. A Job starting now
      // gets its status message, which starts as "on it" and is edited in place from
      // then on. A Job that has to wait gets a receipt saying so, which its status
      // message takes over when it finally starts.
      let acknowledgement: Acknowledgement;
      try {
        acknowledgement = place.waiting
          ? {
              receipt: await postReceipt(deps, mention, place.waiting),
              waited: place.waiting,
            }
          : { started: await statusFor(deps, mention.thread) };
      } catch (error) {
        // Nothing was said in the Thread, so this Job is not happening — and its place
        // has to go with it, or the Thread queues forever behind a Job that never runs.
        place.abandon();
        throw error;
      }

      return {
        jobId: mention.eventId,
        completed: runInTurn(
          deps,
          approvals,
          running,
          vaultWindows,
          vaultChangeLog,
          workspaceLifecycle,
          place,
          mention,
          acknowledgement,
        ).then(() => {}),
      };
    },

    async handleScheduled(request): Promise<ScheduledJob> {
      const mention: Mention = {
        eventId: `schedule-${request.scheduleId}-${request.occurrenceId}`,
        thread: request.thread,
        messageTs: request.thread.ts,
        userId: request.creatorUserId,
        files: [],
        text: [
          request.task,
          "",
          "Trusted Schedule context supplied by open-agent:",
          `- Schedule: ${request.scheduleId}`,
          `- Due: ${request.dueAt}`,
          `- Started: ${request.startedAt}`,
          `- Timezone: ${request.timezone}`,
          `- Previous successful Occurrence: ${request.previousSuccessAt ?? "none"}`,
        ].join("\n"),
      };
      const place = queue.join(mention.thread);
      let acknowledgement: Acknowledgement;
      try {
        acknowledgement = place.waiting
          ? {
              receipt: await postReceipt(deps, mention, place.waiting),
              waited: place.waiting,
            }
          : { started: await statusFor(deps, mention.thread) };
      } catch (error) {
        place.abandon();
        throw error;
      }
      return {
        jobId: mention.eventId,
        completed: runInTurn(
          deps,
          approvals,
          running,
          vaultWindows,
          vaultChangeLog,
          workspaceLifecycle,
          place,
          mention,
          acknowledgement,
        ),
      };
    },
  };
}

/**
 * How this Job's mention was acknowledged, and therefore what its status message does
 * when the work starts: it is either already posted, or a receipt waiting to become one.
 */
type Acknowledgement =
  | { started: JobStatus }
  /** The receipt's `ts`, and what it was waiting for — which the Job's prompt needs. */
  | { receipt: string; waited: WaitReason };

/**
 * Wait for this Job's place in its Thread, then run it — or clean up after it if the
 * Thread was stopped first.
 *
 * A dropped Job leaves a receipt behind promising to pick the message up, which is now
 * untrue. Correcting it matters more than it sounds: the stop reply says *how many* were
 * dropped, and leaving the messages themselves untouched asks the reader to work out
 * which ones from a count.
 */
async function runInTurn(
  deps: CoworkerDeps,
  approvals: Promise<Awaited<ReturnType<typeof createApprovalCoordinator>>>,
  running: Map<string, JobBounds>,
  vaultWindows: VaultWindows,
  vaultChangeLog: VaultChangeLog,
  workspaceLifecycle: WorkspaceLifecycle,
  place: Place,
  mention: Mention,
  acknowledgement: Acknowledgement,
): Promise<JobCompletion> {
  let completion: JobCompletion = "failed";
  const outcome = await place.take(async () => {
    const directory = workspaceDirectory(deps.config, mention.thread);
    const lease = await workspaceLifecycle.use(directory);
    try {
      completion = await runJob(
        deps,
        await approvals,
        running,
        vaultWindows,
        vaultChangeLog,
        workspaceLifecycle,
        mention,
        acknowledgement,
      );
    } finally {
      await lease.release();
    }
  });
  if (outcome === "ran" || !("receipt" in acknowledgement)) return completion;

  deps.log.info(`Dropped queued ${mention.eventId} in thread ${mention.thread.ts}`);
  try {
    await deps.slack.updateMessage({
      thread: mention.thread,
      ts: acknowledgement.receipt,
      text: droppedReceipt(),
    });
  } catch (error) {
    // The Job is already not happening and the stop reply has already said so. Failing
    // the delivery over a tidying edit would turn a cosmetic problem into a logged one.
    deps.log.warn(
      `Could not mark the queued message in thread ${mention.thread.ts} as dropped: ` +
        `${reasonFor(error)}`,
    );
  }
  return "failed";
}

/** Tell the Thread its mention landed and will have to wait. Returns the receipt's ts. */
async function postReceipt(
  deps: CoworkerDeps,
  mention: Mention,
  wait: WaitReason,
): Promise<string> {
  const posted = await deps.slack.postMessage({
    thread: mention.thread,
    text: queueReceipt(wait),
  });
  deps.log.info(`Queued ${mention.eventId} in thread ${mention.thread.ts} (${wait.kind})`);
  return posted.ts;
}

/** The Job's one message, whether it is being posted now or taken over from a receipt. */
function statusFor(deps: CoworkerDeps, thread: Thread, adopt?: string): Promise<JobStatus> {
  return startJobStatus({
    slack: deps.slack,
    clock: deps.clock,
    log: deps.log,
    thread,
    adopt,
  });
}

/**
 * "Stop" from the Thread, which is the only interruption primitive there is.
 *
 * `exec` has no mid-turn steering, so there is nothing to send the agent — the wrapper
 * owns the subprocess and killing it is the whole mechanism. Both answers are posted
 * rather than left implicit: a person who typed "stop" and saw nothing would not know
 * whether it was heard, and if there was nothing running they should find that out
 * from the Thread rather than by waiting.
 *
 * **It empties the Thread's queue too.** Whatever is waiting was almost always written
 * about the work being abandoned, and a person who says stop and then watches the next
 * queued Job start immediately has every reason to conclude that stopping does not
 * work. What was dropped is said out loud, because those are messages that are now not
 * going to be answered.
 */
async function hardStop(
  deps: CoworkerDeps,
  running: Map<string, JobBounds>,
  queue: JobQueue,
  mention: Mention,
): Promise<void> {
  const bounds = running.get(threadKey(mention.thread));
  const stopped = bounds?.stop({ kind: "asked-to-stop", byUserId: mention.userId }) ?? false;
  const dropped = queue.dropWaiting(mention.thread);

  deps.log.info(
    (stopped
      ? `Hard-stopping the Job in thread ${mention.thread.ts} at ${mention.userId}'s request`
      : `Asked to stop thread ${mention.thread.ts}, where nothing is running`) +
      (dropped === 0 ? "" : `, dropping ${dropped} queued mention(s)`),
  );

  await deps.slack.postMessage({
    thread: mention.thread,
    text: stopReply({ stopped, dropped }),
  });
}

async function runJob(
  deps: CoworkerDeps,
  approvals: Awaited<ReturnType<typeof createApprovalCoordinator>>,
  running: Map<string, JobBounds>,
  vaultWindows: VaultWindows,
  vaultChangeLog: VaultChangeLog,
  workspaceLifecycle: WorkspaceLifecycle,
  mention: Mention,
  acknowledgement: Acknowledgement,
): Promise<JobCompletion> {
  // Armed and put in the index **before this function awaits anything**, and that is
  // load-bearing. The queue stops treating this Job as interruptible the moment it
  // hands it the Thread, so a stop arriving in the gap between there and here would
  // find nothing in either place and be answered with "nothing was running" — while
  // the Job it was aimed at carried on. The wall clock wants to start here too: a Job
  // that wedges before its first action is still wedged.
  const bounds = boundJob({ bounds: deps.config.bounds, clock: deps.clock });
  running.set(threadKey(mention.thread), bounds);
  const startedAt = deps.clock.now();

  // A Job that waited takes over the receipt it was acknowledged with, so the Thread
  // gets one message per Job either way. Its elapsed time starts here, at the work,
  // rather than at the mention: how long it queued is not how long it took.
  const status =
    "started" in acknowledgement
      ? acknowledgement.started
      : await statusFor(deps, mention.thread, acknowledgement.receipt);

  let answer = "";
  let failure: string | undefined;
  let plan: readonly PlanStep[] = [];
  /**
   * Undefined only until the workspace exists, because what counts as a Write depends
   * on where this Job's own desk is. Nothing has been written before that point.
   */
  let audit: AuditTrail | undefined;
  /** The Job's working, kept for the Librarian — which does not share its Session. */
  const transcript = recordTranscript();
  /**
   * This Job's view of the Vault: what was in it before, and what it has changed since.
   *
   * Undefined only if the Job failed before it could be opened, in which case nothing had
   * run and nothing can have been written.
   */
  let vault: VaultWindow | undefined;
  let workspaceDir: string | undefined;
  let outputDir: string | undefined;
  let ingestedFiles: readonly IngestedFile[] = [];
  let root: RootNote = NO_ROOT_NOTE;

  try {
    const directory = workspaceDirectory(deps.config, mention.thread);
    const prepared = await prepareWorkspace(deps.config, mention.thread, deps.log, {
      remoteFor: deps.repositoryRemote,
      restorations: await workspaceLifecycle.restorationFor(directory),
    });
    const workingDirectory = prepared.directory;
    workspaceDir = workingDirectory;
    outputDir = await prepareOutputDirectory({
      workspaceDir: workingDirectory,
      jobId: mention.eventId,
    });
    const historyQuery = {
      thread: mention.thread,
      latestMessageTs: mention.messageTs,
    };
    const { files: earlierFiles, messages: threadMessages } =
      await deps.slack.readThread(historyQuery);
    ingestedFiles = await ingestMentionFiles({
      slack: deps.slack,
      workspaceDir: workingDirectory,
      jobId: mention.eventId,
      files: distinctFiles([...earlierFiles.filter(supportsMentionFile), ...mention.files]),
      maxBytes: deps.config.fileTransfer.maxDownloadBytes,
    });
    audit = startAuditTrail({
      slack: deps.slack,
      log: deps.log,
      thread: mention.thread,
      scope: await writeScope({
        workspaceDir: workingDirectory,
        notesDir: deps.config.notesDir,
      }),
    });

    // Opened before the engine starts, and it has to be: everything the Vault records
    // about this Job is the difference between here and afterwards, so a window opened
    // late would attribute the coworker's own earlier Notes to whatever ran next.
    vault = await openVaultWindow({
      notesDir: deps.config.notesDir,
      log: deps.log,
      clock: deps.clock,
      thread: mention.thread,
      jobId: mention.eventId,
      windows: vaultWindows,
      sourceFiles: ingestedFiles.map((file) => file.name),
    });

    // The map, handed over rather than asked for — and stripped to links on the way in,
    // because this is the one file that reaches every Job in every Thread (ADR-0004).
    root = await readRootNote(deps.config.notesDir);
    for (const concern of rootNoteConcerns(root, deps.config.notesDir)) deps.log.warn(concern);

    // Read fresh each Job rather than at startup, because a human edits these in Obsidian
    // while the instance is running and a Skill added an hour ago is a Skill this Job
    // should follow.
    const skills = await readSkills(deps.config.skillsDir);

    const recorded = await deps.sessions.get(deps.tenant, mention.thread);
    const session = openSession(deps, mention.thread, recorded, {
      workingDirectory,
      // The Notes and nothing else. **`skillsDir` must never appear here** — that omission
      // is the whole of ADR-0004's authorship rule for Skills, and adding it would make
      // the coworker able to rewrite the procedures that constrain it without anything
      // else in this codebase failing. `preflight.ts` refuses to start an instance whose
      // Skills sit inside this directory for the same reason.
      writableDirectories: [deps.config.notesDir],
    });
    const turns = trackTurnDurability({
      sessions: deps.sessions,
      tenant: deps.tenant,
      thread: mention.thread,
      known: recorded,
    });
    // Decided before the first event, because it changes how the whole Turn should be
    // approached: a Session whose last Turn was interrupted has to be *told* so.
    const prompt = buildJobPrompt(mention, {
      resumingAfterInterruption: recorded?.interrupted ?? false,
      // Only when it waited behind a Job *in this Thread*. A Job held back by the
      // instance ceiling waited too, but nothing was said in this Thread meanwhile, so
      // telling it that it interrupted something would be telling it a false thing.
      queuedDuringPreviousJob:
        "waited" in acknowledgement && acknowledgement.waited.kind === "job-ahead",
      notesDir: deps.config.notesDir,
      skillsDir: deps.config.skillsDir,
      skills,
      root,
      repositoryAccess: prepared.repositoryAccess,
      ingestedFiles,
      threadMessages,
      outputDir,
    });

    try {
      for await (const event of session.run(prompt, {
        signal: bounds.signal,
        imagePaths: ingestedFiles.filter(isVisualInput).map((file) => file.path),
        onApproval: async (action, engineSignal) => {
          await status.setWaitingForApproval(true);
          const decision = await approvals.authorize(
            action,
            {
              request: mention.text,
              trustedHumanMessages: threadMessages
                .filter((message) => message.userId === mention.userId)
                .map((message) => message.text),
              threadKey: threadKey(mention.thread),
              requesterUserId: mention.userId,
              workspaceDirectory: workingDirectory,
            },
            mention.thread,
            engineSignal === undefined
              ? bounds.signal
              : AbortSignal.any([bounds.signal, engineSignal]),
          );
          if (!bounds.signal.aborted) await status.setWaitingForApproval(false);
          return decision;
        },
      })) {
        // Everything the engine does reaches the status message, which shows the plan
        // and the step it is on. Nothing is announced as its own message: individual
        // tool calls belong in the one message a glance can read.
        status.observe(event);
        // And anything that was a Write — an action against something outside itself —
        // is appended to the Thread permanently. The two channels see the same events
        // and are opposite in what they do with them.
        audit.observe(event);
        // And the bounds count it. None of the three exists in the engine.
        bounds.observe(event);
        // And the transcript keeps it, because the Librarian's pass is a separate call
        // with none of this Session's context and has to be told what happened.
        transcript.observe(event);
        // And the Turn boundaries are written down, so that a Job which stops here
        // leaves the next one able to tell that it did.
        await turns.observe(event);

        switch (event.type) {
          case "plan":
            // Kept for the report: if this Job dies, its plan is the only account of
            // what it meant to do and how far it got.
            plan = event.steps;
            break;
          case "message":
            // The last agent message is the answer; earlier ones are working notes.
            answer = event.text;
            break;
          case "turn-failed":
          case "engine-error":
            failure = event.message;
            break;
          default:
            // Session and Turn boundaries are the observers' above; everything else
            // the two output channels have already taken.
            break;
        }

        // A bound that tripped on this event has already killed the subprocess. Leaving
        // the loop closes the stream too, which is the belt to that braces.
        if (bounds.stoppedBy !== undefined) break;
      }
    } catch (error) {
      // The abort we asked for arrives here as a failure. It is not one, and the reason
      // the bound holds is a better account of what happened than the abort's own.
      if (bounds.stoppedBy === undefined) throw error;
    }
  } catch (error) {
    failure = reasonFor(error);
  }

  /**
   * How the *work* ended, captured before curation runs.
   *
   * A stop landing during the Librarian's pass aborts the pass — the Job's own bound is
   * what the pass runs on, deliberately, so that "stop" reaches the whole Job — and it
   * must not turn a Job that finished into a Job that was stopped. The answer is already
   * in hand at this point; what a late stop cancels is the tidying up.
   */
  const stoppedBy = bounds.stoppedBy;

  if (outputDir !== undefined && audit !== undefined) {
    const results = await shareResultFiles({
      slack: deps.slack,
      thread: mention.thread,
      outputDir,
      maxBytes: deps.config.fileTransfer.maxUploadBytes,
    });
    if (results.unshared.length > 0) {
      const sharedSentence =
        results.shared.length === 0
          ? ""
          : `I shared ${results.shared.map((result) => result.filename).join(", ")}. `;
      const unsharedNames = results.unshared.map((result) => result.filename).join(", ");
      // A model may optimistically say that it attached a file before this delivery
      // boundary actually runs. Once delivery fails, replace that draft with an account
      // grounded in the observed result so the Thread never receives a false claim.
      answer =
        `${sharedSentence}I completed the work, but I could not share ${unsharedNames}. ` +
        `The result files remain in the Job workspace at ${outputDir}.`;
      const summary = results.unshared
        .map((result) => `${result.filename}: ${result.reason}`)
        .join("; ");
      failure =
        failure === undefined
          ? `I could not share ${results.unshared.length === 1 ? "a result file" : "some result files"}: ${summary}`
          : `${failure}; I also could not share result files: ${summary}`;
    }
  }

  if (stoppedBy !== undefined) {
    deps.log.warn(
      `Job ${mention.eventId} in thread ${mention.thread.ts} was stopped — ` +
        `${stopSentence(stoppedBy)} Tokens spent: ${bounds.tokensSpent}.`,
    );
  }

  // Whatever the work did to the Vault, logged from the Vault itself before the answer.
  // Runs for a stopped Job too: a Note
  // written before the stop is still a Note, and stopping undid nothing.
  if (vault !== undefined) await vault.settle(vaultChangeLog);

  // Every external Write receipt so far lands before the answer.
  await audit?.drain();
  const report: JobReport = reportFor({
    answer,
    stoppedBy,
    failure,
    plan,
    recorded: audit?.recorded ?? 0,
    unrecorded: audit?.unrecorded ?? 0,
  });

  // Settled before the answer is posted, so the Thread reads in the order it happened
  // and the status has stopped moving by the time anyone reads the result.
  await status.settle(report.outcome);
  await deps.slack.postMessage({
    thread: mention.thread,
    text: report.text,
    // Engine answers are standard Markdown. Slack's older `text` field parses its
    // similar-looking mrkdwn dialect, which misrenders headings, links, and tables.
    format: "markdown",
  });

  // Only now, with the answer delivered, does the coworker tidy up. Curation is
  // best-effort and takes as long as it takes, so anything the person is waiting for has
  // to be out of the way first — the spec's "the work is already done and reported" is a
  // statement about this ordering. Whatever the pass files is logged after the answer.
  try {
    await tidyUp(deps, mention, {
      stoppedBy,
      workspaceDir,
      root,
      transcript: transcript.text(),
      answer,
      signal: bounds.signal,
      vault,
      vaultChangeLog,
      ingestedFiles,
    });
  } finally {
    bounds.release();
    // Unconditionally: the queue holds this Thread's next Job until this function's
    // promise settles, so nothing else can have taken this entry in the meantime.
    running.delete(threadKey(mention.thread));
    deps.log.info(
      `Job ${mention.eventId} finished in ${deps.clock.now() - startedAt}ms ` +
        `(thread ${mention.thread.ts})`,
    );
    vault?.close();
  }
  if (stoppedBy?.kind === "turn-timeout") return "timed-out";
  if (stoppedBy !== undefined || failure !== undefined) return "failed";
  return "succeeded";
}

function distinctFiles(files: readonly MentionFile[]): readonly MentionFile[] {
  const byIdentity = new Map<string, MentionFile>();
  for (const [index, file] of files.entries()) {
    const identity =
      file.id === "unknown"
        ? `${file.privateDownloadUrl}\u0000${file.name}\u0000${index}`
        : file.id;
    byIdentity.set(identity, file);
  }
  return [...byIdentity.values()];
}

/**
 * The Librarian's closing pass, and the record of anything it filed.
 *
 * Never throws: everything in here happens after the human has their answer, so a failure
 * is a warning in the log and nothing else. That is not laxness — it is the difference
 * between losing a tidy-up and losing the work it was tidying.
 */
async function tidyUp(
  deps: CoworkerDeps,
  mention: Mention,
  job: {
    stoppedBy: StopReason | undefined;
    workspaceDir: string | undefined;
    root: RootNote;
    transcript: string;
    answer: string;
    signal: AbortSignal;
    vault: VaultWindow | undefined;
    vaultChangeLog: VaultChangeLog;
    ingestedFiles: readonly IngestedFile[];
  },
): Promise<void> {
  // Skipped for a Job that was stopped, and that is a judgement rather than a shortcut:
  // someone who says "stop" and then watches their Notes get rewritten has not been
  // listened to, and a bound that tripped means the transcript this pass would read is the
  // transcript of something that did not finish.
  if (job.stoppedBy !== undefined || job.workspaceDir === undefined) return;

  const pass = await runLibrarianPass(
    {
      engine: deps.engine,
      clock: deps.clock,
      log: deps.log,
      timeoutMs: deps.config.bounds.librarianTimeoutMs,
      signal: job.signal,
    },
    {
      notesDir: deps.config.notesDir,
      workingDirectory: job.workspaceDir,
      root: job.root,
      request: librarianRequest(mention.text, job.ingestedFiles),
      transcript: job.transcript,
      answer: job.answer,
    },
  );

  if (pass.failure !== undefined) {
    deps.log.warn(
      `The Librarian pass for Job ${mention.eventId} did not finish: ${pass.failure}. ` +
        "The work itself is unaffected; nothing may have been filed.",
    );
  } else {
    deps.log.info(`Librarian pass for Job ${mention.eventId}: ${pass.said || "(nothing said)"}`);
  }

  // Even a pass that failed part-way may have written something, so the Vault is asked
  // either way. A Note that exists and is unlogged is the one outcome this must not have.
  if (job.vault !== undefined) {
    await job.vault.settle(job.vaultChangeLog);
  }
}

function librarianRequest(message: string, files: readonly IngestedFile[]): string {
  if (files.length === 0) return message;
  return [
    message,
    "",
    "Slack Thread files used as untrusted source material:",
    ...files.map((file) => `- ${file.name} (${file.mimetype}) at ${file.path}`),
    "",
    "If a Note derives a durable fact from one of these files, name that source file in",
    "the Note so its provenance includes more than the Thread and Job stamps.",
  ].join("\n");
}

/**
 * The Thread's Session: resumed if it has one, started if this is its first Job.
 *
 * Exactly one Session per Thread for the life of the Thread, so a follow-up three
 * days later remembers what was said. Sessions are never shared between Threads —
 * Threads have different audiences, and a Session that could see another Thread's
 * conversation would put a private channel one question from a public answer. The
 * only channel between them is the Vault (ADR-0003).
 */
function openSession(
  deps: CoworkerDeps,
  thread: Thread,
  recorded: SessionRecord | undefined,
  options: SessionOptions,
): EngineSession {
  if (recorded === undefined) {
    deps.log.info(`Starting a new Session for thread ${thread.ts}`);
    return deps.engine.startSession(options);
  }
  deps.log.info(`Resuming Session ${recorded.id} for thread ${thread.ts}`);
  return deps.engine.resumeSession(recorded.id, options, recorded.locator);
}
