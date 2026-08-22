import type { MentionFile } from "../files/types.ts";
import type { Thread } from "../thread.ts";

/**
 * What the coworker needs from Slack, and nothing more.
 *
 * The real implementation wraps Bolt's `WebClient`; tests substitute a fake and
 * assert on the calls made. Keeping this narrow is what makes "assert on the Slack
 * calls" a readable test rather than a mock-heavy one.
 */

export interface PostMessage {
  /** Every message the coworker posts is threaded — the answer lives with the question. */
  thread: Thread;
  text: string;
  /** Model answers use standard Markdown; app-authored messages use Slack mrkdwn. */
  format?: "markdown" | "mrkdwn";
  /** Slack deduplicates retries carrying the same client-generated identifier. */
  idempotencyKey?: string;
}

export interface PostedMessage {
  /** The new message's own `ts` — needed to edit it later. */
  ts: string;
}

export const APPROVE_ONCE_ACTION = "approval_approve_once";
export const ALLOW_SIMILAR_ACTION = "approval_allow_similar";
export const DENY_ACTION = "approval_deny";

export interface ApprovalPost {
  thread: Thread;
  requestId: string;
  category: string;
  target: string;
  environment: string;
  preview: string;
  effect: string;
  risk: string;
  reason: string;
  grantScope: string;
}

export interface ApprovalPresentation extends ApprovalPost {
  actions: readonly { actionId: string; label: string; value: string; style?: "primary" | "danger" }[];
}

export interface SettleApproval { thread: Thread; ts: string; text: string; }
export interface EphemeralMessage { thread: Thread; userId: string; text: string; }

export interface SlackChannel {
  id: string;
  name: string;
}

export interface PostTopLevelMessage {
  channel: string;
  text: string;
}

export interface UpdateMessage {
  thread: Thread;
  /**
   * The message to rewrite. Only ever the Job's status message: a Write record is
   * appended and never edited, because the Thread is the accountability trail.
   */
  ts: string;
  text: string;
  /** Must match the format used when the message was posted. */
  format?: "markdown" | "mrkdwn";
}

export interface SetStatus {
  thread: Thread;
  /** Slack's own "is thinking…" phrasing. An empty string clears the indicator. */
  status: string;
}

export interface DownloadFile {
  /** Slack's private download URL from the file object on the mention event. */
  url: string;
}

export interface DownloadedFile {
  bytes: Buffer;
  contentType: string | undefined;
}

export interface ReadThread {
  thread: Thread;
  /** Do not let a queued Job absorb context posted after the mention that created it. */
  latestMessageTs: string;
}

export interface SlackThreadMessage {
  ts: string;
  userId: string;
  text: string;
}

export interface SlackThreadHistory {
  messages: readonly SlackThreadMessage[];
  files: readonly MentionFile[];
}

export interface UploadFile {
  thread: Thread;
  filename: string;
  bytes: Buffer;
  /** A short permanent introduction attached to the file message. */
  comment: string;
}

export interface UploadedFile {
  /** Slack's human-facing file URL, when the upload response includes it. */
  permalink: string | undefined;
}

/** Who the instance is, according to Slack. What `auth.test` answers. */
export interface SlackIdentity {
  /** The bot's own user id — the one that appears in `<@…>` when someone mentions it. */
  botUserId: string;
  /** The workspace the tokens belong to, so a startup line can name it. */
  team: string;
}

export interface SlackClient {
  /**
   * Ask Slack who these tokens belong to.
   *
   * Called once at startup and nowhere else. The instance would otherwise discover a bad
   * bot token on the first mention — as a Job that accepted the work, said nothing, and
   * failed in the log — which is the failure preflight exists to move to a moment when
   * somebody is watching.
   */
  identity(): Promise<SlackIdentity>;
  /** The IANA timezone stored on a Slack member profile. */
  userTimezone(userId: string): Promise<string | undefined>;
  /** Resolve a channel id/name and prove the bot can start a threaded conversation there. */
  resolveWritableChannel(reference: string): Promise<SlackChannel>;
  /** Start a new channel conversation. Its timestamp becomes the Job's Thread. */
  postTopLevelMessage(message: PostTopLevelMessage): Promise<PostedMessage>;
  /** Fetch a private Slack file with the bot token. */
  downloadFile(file: DownloadFile): Promise<DownloadedFile>;
  /** Retrieve Thread messages and files up to and including the triggering message. */
  readThread(query: ReadThread): Promise<SlackThreadHistory>;
  /** Upload an artifact and share it directly into the originating Thread. */
  uploadFile(file: UploadFile): Promise<UploadedFile>;
  postMessage(message: PostMessage): Promise<PostedMessage>;
  postApproval(message: ApprovalPost): Promise<PostedMessage>;
  settleApproval(message: SettleApproval): Promise<void>;
  postEphemeral(message: EphemeralMessage): Promise<void>;
  /**
   * Rewrite a message in place. Preferred over posting for progress: `chat.update` is
   * Tier 3 (50+/minute) where `chat.postMessage` is about one per second per channel,
   * and one message that changes beats a wall of narration to scroll past.
   */
  updateMessage(message: UpdateMessage): Promise<void>;
  /**
   * Slack's native loading indicator on the Thread.
   *
   * It is removed two minutes after the last call, which is the clock every long Job
   * has to beat: the indicator vanishing is what makes a quiet ten-minute command
   * look like a crash.
   */
  setStatus(status: SetStatus): Promise<void>;
}
