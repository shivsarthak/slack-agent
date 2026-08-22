import { reasonFor } from "../failure.ts";
import type { Clock } from "../ports/clock.ts";
import type { EngineEvent, FileChange, PlanStep } from "../ports/engine.ts";
import type { Logger } from "../ports/log.ts";
import type { SlackClient } from "../ports/slack.ts";
import type { Thread } from "../thread.ts";
import { code, mrkdwn, oneLine } from "./mrkdwn.ts";

/**
 * Progress: one message per Job, edited in place.
 *
 * A person delegates something long and walks away. When they glance back at the
 * Thread, **one** message tells them what the coworker is doing and how far through
 * it is — not a wall of narration to scroll past. So this owns a single message for
 * the life of a Job: posted before any work starts, rewritten as the plan advances,
 * and settled into a final line when the Job ends.
 *
 * Two things it deliberately does not do:
 *
 * - **It never posts twice.** Individual tool calls are folded into the one message
 *   rather than announced. The other output channel — `./audit.ts`, a permanent record
 *   of every Write — has the opposite semantics on purpose.
 * - **It never fails a Job.** Progress is a courtesy and the answer is the work, so
 *   a Slack refusal here is warned about once and then endured.
 */

/**
 * How often the status considers rewriting itself.
 *
 * Writing on every engine event would be simpler and wrong: `chat.update` is Tier 3
 * — 50+ per minute — and a Job revising its plan in a tight loop would spend that on
 * its own. Polling caps one Job at 12 writes a minute, and costs at most this long
 * before a plan change shows up.
 *
 * **The tier is per app per workspace, not per Job**, and Jobs in different Threads
 * run concurrently, so the instance-wide exposure is this cap times however many Jobs
 * are running. That number is bounded — `maxConcurrentJobs` defaults to four for this
 * reason, four times twelve being just inside Slack's fifty — but it is configurable,
 * so the arithmetic stops holding for an instance that raises it. In practice a Job's
 * plan changes every few tens of seconds rather than every five, so the steady state is
 * closer to the heartbeat alone; the pathological case is many Jobs all churning at
 * once, and {@link STATUS_BACKOFF_MS} is what makes that survivable rather than
 * prevented.
 */
export const STATUS_POLL_MS = 5_000;

/**
 * How long to leave the status message alone after Slack refuses a write.
 *
 * Slack answers a breached limit with `429` and a `Retry-After`, which this does not
 * read — the seam carries an opaque failure, and widening it to carry a header would
 * be the Reporter knowing about HTTP. A flat pause longer than Slack's own typical
 * retry window is the honest version: it stops the hammering without pretending to
 * know when the door reopens. Slack's *indicator* keeps beating through it, because
 * that is a different method on a far larger allowance and it is what tells the human
 * the Job is still alive.
 */
export const STATUS_BACKOFF_MS = 60_000;

/**
 * The longest the status may go unwritten while a Job runs.
 *
 * Well inside {@link SLACK_STATUS_TIMEOUT_MS}, because the refresh has to survive an
 * event loop busy with other Threads' Jobs and still beat Slack's clock.
 */
export const STATUS_HEARTBEAT_MS = 45_000;

/**
 * Slack removes its loading indicator two minutes after the last `setStatus` call.
 *
 * This is the number the heartbeat exists to stay under. It is exported so that a
 * test asserts against Slack's actual constraint rather than against our cadence.
 */
export const SLACK_STATUS_TIMEOUT_MS = 120_000;

/** How a Job ended, as far as the person watching is concerned. */
export type JobOutcome = "finished" | "stopped";

export interface JobStatus {
  /**
   * Fold what the engine just did into the status. Cheap and synchronous — it never
   * talks to Slack, so an engine emitting a hundred events costs a hundred variable
   * assignments rather than a hundred API calls.
   */
  observe(event: EngineEvent): void;
  /** Replace in-flight activity with the stable human decision wait, then resume. */
  setWaitingForApproval(waiting: boolean): Promise<void>;
  /** The Job is over: write the final state, and stop refreshing. */
  settle(outcome: JobOutcome): Promise<void>;
}

export interface StatusDeps {
  slack: SlackClient;
  clock: Clock;
  log: Logger;
  thread: Thread;
  /**
   * A message already in the Thread for this Job, to take over instead of posting.
   *
   * A Job that had to wait was acknowledged when its mention arrived — minutes or
   * hours before it started — and that receipt is this Job's one message. Rewriting it
   * is what Progress is: one thing per Job, revised. Posting a second message would
   * leave the Thread with a stale "I'll get to this" sitting above a live status.
   */
  adopt?: string | undefined;
}

/**
 * What the coworker is doing **right now**, in one line — or nothing, in between.
 *
 * Only things genuinely in flight go here, and their completion clears it. The two
 * tempting additions are both wrong. A reasoning summary is the coworker's private
 * working, and this message is read in a channel by colleagues who did not ask the
 * question; what it is *thinking* belongs in the plan, which is written for them. And
 * a finished web search has no in-progress event to clear it, so it would sit there
 * claiming to be happening — a concrete "right now" inverted into a stale one, which
 * is worse than the spinner it was meant to beat.
 */
interface Activity {
  /** The doing: "Running", "Editing", "Asking linear for". */
  verb: string;
  /** What it is being done to — a command, a path, a tool. Rendered as code. */
  subject: string | undefined;
}

interface StatusState {
  stage: "working" | JobOutcome;
  plan: readonly PlanStep[];
  activity: Activity | undefined;
  elapsedMs: number;
}

/**
 * Post the Job's status message and start refreshing it.
 *
 * This is also the acknowledgement the human sees within seconds of mentioning the
 * coworker: the same message, in its first state. Two messages — "on it" and then a
 * progress message — would be one more than the Thread needs.
 */
export async function startJobStatus(deps: StatusDeps): Promise<JobStatus> {
  const startedAt = deps.clock.now();
  let plan: readonly PlanStep[] = [];
  let activity: Activity | undefined;
  /**
   * Bumped whenever the *content* changes, so a poll can tell news from a heartbeat.
   * Comparing rendered text would not work — the elapsed time changes every render.
   */
  let revision = 0;
  let writtenRevision = 0;
  let lastWriteAt = startedAt;
  /** Set when Slack refuses a write, so a rate-limited instance stops pushing. */
  let quietUntil = 0;
  let settled = false;
  /**
   * While a Job waits on a human approval, nothing is being generated — so Slack's
   * native loading indicator is cleared rather than refreshed. Leaving it beating
   * shows "Generating response…" under an approval prompt, which reads as the
   * opposite of what is happening: the coworker is stopped, waiting on the human.
   */
  let waitingForApproval = false;
  /**
   * Writes are chained rather than fired concurrently: two overlapping `chat.update`
   * calls can land out of order, and the one that must land last is the final state.
   */
  let pending: Promise<void> = Promise.resolve();
  /**
   * What has already been complained about, **per kind**.
   *
   * One flag for all of them was a bug: on a workspace whose Slack app predates the
   * 2026-03-05 scope change, `setStatus` fails on the very first call and would spend
   * the single warning before any work started — after which every failure to write
   * the status message itself, which is the one that matters, went unlogged.
   */
  const complainedAbout = new Set<string>();

  const state = (stage: StatusState["stage"]): StatusState => ({
    stage,
    plan,
    activity,
    elapsedMs: deps.clock.now() - startedAt,
  });

  const complain = (what: string, error: unknown): void => {
    // Once per kind per Job. A Slack outage during an hour-long Job would otherwise
    // fill the log with the same line every 45 seconds and bury what else went wrong.
    if (complainedAbout.has(what)) return;
    complainedAbout.add(what);
    deps.log.warn(
      `Could not ${what} in thread ${deps.thread.ts}: ${reasonFor(error)}. The Job is ` +
        "still running and will still post its answer; progress reporting may be stale.",
    );
  };

  /**
   * Slack's own indicator, on the same beat as the message — this is the thing that
   * actually expires, and refreshing it is what keeps a silent Job looking alive.
   * Cleared when the Job settles rather than left spinning on finished work.
   *
   * Never rejects: the indicator is the most decorative thing here.
   */
  const indicate = async (current: StatusState): Promise<void> => {
    try {
      await deps.slack.setStatus({
        thread: deps.thread,
        status: current.stage === "working" && !waitingForApproval ? nativeStatus(current) : "",
      });
    } catch (error) {
      complain("refresh Slack's status indicator", error);
    }
  };

  /** The one message this Job owns: the receipt it was given, or a new one. */
  const messageTs =
    deps.adopt ??
    (
      await deps.slack.postMessage({
        thread: deps.thread,
        text: render(state("working")),
      })
    ).ts;

  /** Never rejects: the caller is either a detached timer tick or the Job's last act. */
  const write = async (stage: StatusState["stage"]): Promise<void> => {
    const current = state(stage);
    // A settled Job writes regardless: the final state is the one that has to land,
    // and it is one call rather than a cadence.
    const forced = current.stage !== "working";
    if (forced || deps.clock.now() >= quietUntil) {
      try {
        await deps.slack.updateMessage({
          thread: deps.thread,
          ts: messageTs,
          text: render(current),
        });
      } catch (error) {
        quietUntil = deps.clock.now() + STATUS_BACKOFF_MS;
        complain("update the status message", error);
      }
    }
    await indicate(current);
  };

  const queue = (stage: StatusState["stage"]): Promise<void> => {
    lastWriteAt = deps.clock.now();
    writtenRevision = revision;
    pending = pending.then(() => write(stage));
    return pending;
  };

  if (deps.adopt === undefined) {
    // Lit immediately rather than on the first poll: Slack's own guidance is to show
    // something the moment the request lands, and that is what this message is for.
    await indicate(state("working"));
  } else {
    // An adopted receipt still says "I'll get to this" until it is rewritten, so the
    // first write happens now rather than up to a poll later — and it goes through
    // `write`, so a Slack refusal here is endured like any other.
    await queue("working");
  }

  const refresh = (): Promise<void> | void => {
    if (settled) return;
    const changed = revision !== writtenRevision;
    if (!changed && deps.clock.now() - lastWriteAt < STATUS_HEARTBEAT_MS) return;
    return queue("working");
  };

  const timer = deps.clock.every(STATUS_POLL_MS, refresh);

  /**
   * Both of these compare before bumping. The engine re-emits an item every time it
   * touches it, and a revision that did not change the content would spend a
   * `chat.update` rewriting the message with what it already says.
   */
  const bumpActivity = (next: Activity | undefined): void => {
    if (sameActivity(activity, next)) return;
    activity = next;
    revision++;
  };

  const bumpPlan = (next: readonly PlanStep[]): void => {
    if (samePlan(plan, next)) return;
    plan = next;
    revision++;
  };

  return {
    async setWaitingForApproval(waiting): Promise<void> {
      waitingForApproval = waiting;
      bumpActivity(waiting ? { verb: "Waiting for approval", subject: undefined } : undefined);
      await queue("working");
    },
    observe(event: EngineEvent): void {
      switch (event.type) {
        case "plan":
          bumpPlan(event.steps);
          break;
        case "command":
          bumpActivity(
            event.status === "in-progress"
              ? { verb: "Running", subject: event.command }
              : undefined,
          );
          break;
        case "file-change":
          bumpActivity(event.status === "in-progress" ? editing(event.changes) : undefined);
          break;
        case "tool-call":
          bumpActivity(
            event.status === "in-progress"
              ? { verb: `Asking ${event.server} for`, subject: event.tool }
              : undefined,
          );
          break;
        default:
          // Session and Turn boundaries and the answer itself are the Job's business,
          // and reasoning and web searches deliberately reach nothing — see Activity.
          break;
      }
    },

    async settle(outcome: JobOutcome): Promise<void> {
      if (settled) return;
      settled = true;
      timer.stop();
      // Chained behind any in-flight refresh, so the final state is what stays.
      await queue(outcome);
    },
  };
}

const STAGES: Record<StatusState["stage"], { icon: string; headline: string }> = {
  working: { icon: ":hourglass_flowing_sand:", headline: "On it" },
  finished: { icon: ":white_check_mark:", headline: "Done" },
  stopped: { icon: ":warning:", headline: "Stopped" },
};

const WAITING = "I'll post the answer in this thread when I'm done.";

/**
 * The status message, as Slack mrkdwn.
 *
 * It opens with an emoji and a bold headline where the coworker's answers are plain
 * prose, which is the whole of "visually distinct": someone scrolling the Thread a
 * week later can see at a glance which messages were working and which were output.
 */
function render(state: StatusState): string {
  const { icon, headline } = STAGES[state.stage];
  const lines = [`${icon} *${headline}* · ${elapsed(state.elapsedMs)}`];

  if (state.stage === "working" && state.activity) {
    lines.push(activityLine(state.activity));
  }

  if (state.plan.length > 0) {
    lines.push("");
    // A settled Job has no step it is "on", so nothing is singled out — and anything
    // left unfinished stays visibly unfinished rather than being tidied into a tick.
    const current = state.stage === "working" ? currentStep(state.plan) : undefined;
    for (const [index, step] of state.plan.entries()) {
      lines.push(stepLine(step, index === current));
    }
  } else if (state.stage === "working" && state.activity === undefined) {
    lines.push(`_${WAITING}_`);
  }

  return lines.join("\n");
}

function activityLine(activity: Activity): string {
  const verb = `_${mrkdwn(activity.verb)}_`;
  return activity.subject === undefined ? verb : `${verb} ${code(activity.subject)}`;
}

function stepLine(step: PlanStep, current: boolean): string {
  if (step.completed) return `✓ ${mrkdwn(step.text)}`;
  return current ? `▸ *${mrkdwn(step.text)}*` : `◦ ${mrkdwn(step.text)}`;
}

/** The step the coworker is on: the first it has not finished. */
function currentStep(plan: readonly PlanStep[]): number | undefined {
  const index = plan.findIndex((step) => !step.completed);
  return index === -1 ? undefined : index;
}

/**
 * Slack's own indicator, which renders after the app's name — hence "is …".
 *
 * Plain text, deliberately: this one is not mrkdwn, and the step the coworker is on
 * says more than a generic spinner phrase.
 */
function nativeStatus(state: StatusState): string {
  const current = currentStep(state.plan);
  const step = current === undefined ? undefined : state.plan[current];
  if (step) return `is working on: ${oneLine(step.text, 100)}`;
  if (state.activity) {
    const { verb, subject } = state.activity;
    const said = subject === undefined ? verb : `${verb} ${subject}`;
    return `is ${lowerFirst(oneLine(said, 100))}`;
  }
  return "is working…";
}

function editing(changes: readonly FileChange[]): Activity {
  const first = changes[0];
  if (first === undefined) return { verb: "Editing files", subject: undefined };
  return {
    verb: changes.length > 1 ? `Editing ${changes.length} files, including` : "Editing",
    subject: first.path,
  };
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function sameActivity(left: Activity | undefined, right: Activity | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.verb === right.verb && left.subject === right.subject;
}

function samePlan(left: readonly PlanStep[], right: readonly PlanStep[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (step, index) =>
        step.text === right[index]?.text && step.completed === right[index]?.completed,
    )
  );
}
