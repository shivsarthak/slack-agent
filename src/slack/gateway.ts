import { App } from "@slack/bolt";
import type { Config } from "../config.ts";
import type { Logger } from "../ports/log.ts";
import type {
  DownloadFile,
  DownloadedFile,
  PostMessage,
  PostedMessage,
  ReadThread,
  SetStatus,
  SlackClient,
  SlackIdentity,
  SlackThreadHistory,
  SlackThreadMessage,
  UpdateMessage,
  UploadedFile,
  UploadFile,
  ApprovalPost,
  SettleApproval,
  EphemeralMessage,
} from "../ports/slack.ts";
import {
  ALLOW_SIMILAR_ACTION,
  APPROVE_ONCE_ACTION,
  DENY_ACTION,
} from "../ports/slack.ts";
import { toMentionFile, type MentionGateway } from "./mentions.ts";
import type { ApprovalClick, ApprovalClickResult, HumanApprovalDecision } from "../approvals/coordinator.ts";

/**
 * Bolt, Socket Mode, and the `app_mention` subscription.
 *
 * Socket Mode is deliberate despite Slack's production guidance: a self-hoster has
 * no public HTTPS endpoint, and the long-Job design means the three-second ack race
 * is already won either way.
 */
export function createSlackApp(config: Config): App {
  return new App({
    token: config.slack.botToken,
    appToken: config.slack.appToken,
    socketMode: true,

    // MUST stay false (it is also the default).
    //
    // Setting `processBeforeResponse: true` makes Bolt ack *after* the listener
    // returns, and a listener that takes longer than three seconds gets the event
    // redelivered — measured at **four duplicate runs** for one mention. It is also
    // the reason a FaaS deployment is not viable for this project: there, acking
    // after the handler is the only option.
    processBeforeResponse: false,
  });
}

/** The narrow Slack surface the coworker actually uses, backed by Bolt's client. */
export function slackClientFor(app: App, botToken: string): SlackClient {
  return {
    /**
     * `auth.test`, which is the only call that validates the bot token without posting
     * anything. Bolt's own `app.start()` proves the *app-level* token by opening the socket;
     * this proves the other one, which is the one every reply depends on.
     */
    async identity(): Promise<SlackIdentity> {
      const result = await app.client.auth.test();
      if (!result.user_id) {
        throw new Error("Slack accepted auth.test but named no user, which should not happen");
      }
      return { botUserId: result.user_id, team: result.team ?? "an unnamed workspace" };
    },

    async userTimezone(userId): Promise<string | undefined> {
      const result = await app.client.users.info({ user: userId });
      return result.user?.tz || undefined;
    },

    async resolveWritableChannel(reference) {
      const trimmed = reference.trim();
      const mentioned = /^<#([A-Z0-9]+)(?:\|([^>]+))?>$/.exec(trimmed);
      const given = mentioned?.[1] ?? trimmed.replace(/^#/, "");
      const looksLikeId = /^[CGD][A-Z0-9]+$/.test(given);
      // A picker mention/ID is already Slack's canonical destination. Avoid listing the
      // whole workspace just to rediscover it: that requires channels:read/groups:read,
      // while the creation post below is the definitive writability check.
      if (looksLikeId) return { id: given, name: mentioned?.[2] ?? given };
      const matches: { id: string; name: string; archived: boolean; writable: boolean }[] = [];
      let cursor: string | undefined;
      do {
        const result = await app.client.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: false,
          limit: 200,
          ...(cursor ? { cursor } : {}),
        });
        for (const channel of result.channels ?? []) {
          if (!channel.id || !channel.name) continue;
          if ((looksLikeId && channel.id !== given) || (!looksLikeId && channel.name !== given)) continue;
          const shape = channel as typeof channel & { is_read_only?: boolean; is_non_threadable?: boolean };
          matches.push({
            id: channel.id,
            name: channel.name,
            archived: channel.is_archived === true,
            writable:
              channel.is_member === true &&
              shape.is_read_only !== true &&
              shape.is_non_threadable !== true,
          });
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor);
      if (matches.length === 0) throw new Error(`I cannot find Slack channel ${reference}.`);
      if (matches.length > 1) throw new Error(`Slack channel ${reference} is ambiguous; mention it with Slack's channel picker.`);
      const channel = matches[0]!;
      if (channel.archived) throw new Error(`#${channel.name} is archived.`);
      if (!channel.writable) throw new Error(`I cannot start a threaded message in #${channel.name}; invite the bot and check its posting restrictions.`);
      return { id: channel.id, name: channel.name };
    },

    async postTopLevelMessage(message) {
      const result = await app.client.chat.postMessage({ channel: message.channel, text: message.text });
      if (!result.ts) throw new Error("Slack accepted the message but returned no timestamp");
      return { ts: result.ts };
    },

    async downloadFile(file: DownloadFile): Promise<DownloadedFile> {
      const response = await fetch(file.url, {
        headers: { authorization: `Bearer ${botToken}` },
        redirect: "follow",
      });
      if (!response.ok) {
        throw new Error(`Slack file download returned HTTP ${response.status}`);
      }
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") ?? undefined,
      };
    },

    async readThread(query: ReadThread): Promise<SlackThreadHistory> {
      const files = [];
      const messages: SlackThreadMessage[] = [];
      let cursor: string | undefined;
      do {
        const result = await app.client.conversations.replies({
          channel: query.thread.channel,
          ts: query.thread.ts,
          latest: query.latestMessageTs,
          inclusive: true,
          limit: 200,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const message of result.messages ?? []) {
          if (message.ts) {
            messages.push({
              ts: message.ts,
              userId: message.user ?? message.bot_id ?? "unknown",
              text: message.text ?? "",
            });
          }
          for (const file of message.files ?? []) files.push(toMentionFile(file));
        }
        cursor = result.response_metadata?.next_cursor || undefined;
      } while (cursor !== undefined);
      return { messages, files };
    },

    async uploadFile(file: UploadFile): Promise<UploadedFile> {
      const result = await app.client.files.uploadV2({
        channel_id: file.thread.channel,
        thread_ts: file.thread.ts,
        filename: file.filename,
        title: file.filename,
        initial_comment: file.comment,
        file: file.bytes,
      });
      const uploaded = (result as { files?: { permalink?: string }[] }).files?.[0];
      return { permalink: uploaded?.permalink };
    },

    async postMessage(message: PostMessage): Promise<PostedMessage> {
      const result = await app.client.chat.postMessage({
        channel: message.thread.channel,
        thread_ts: message.thread.ts,
        ...(message.idempotencyKey
          ? { client_msg_id: message.idempotencyKey }
          : {}),
        ...(message.format === "markdown"
          ? { markdown_text: message.text }
          : { text: message.text }),
      });
      if (!result.ts) {
        throw new Error("Slack accepted the message but returned no ts");
      }
      return { ts: result.ts };
    },

    async postApproval(message: ApprovalPost): Promise<PostedMessage> {
      const fields = [
        `*Action:* ${message.category}`,
        `*Target:* ${message.target}`,
        `*Environment:* ${message.environment}`,
        `*Effect:* ${message.effect}`,
        `*Preview:* \`${message.preview.replaceAll("`", "ˋ")}\``,
        `*Risk:* ${message.risk}`,
        `*Why:* ${message.reason}`,
        `*Allow similar scope:* ${message.grantScope}`,
        "The Job is paused on this exact action.",
      ].join("\n");
      const result = await app.client.chat.postMessage({
        channel: message.thread.channel, thread_ts: message.thread.ts,
        text: `Approval required for ${message.category} on ${message.target}. The Job is paused.`,
        blocks: [
          { type: "header", text: { type: "plain_text", text: "Approval required" } },
          { type: "section", text: { type: "mrkdwn", text: fields } },
          { type: "actions", elements: [
            { type: "button", action_id: APPROVE_ONCE_ACTION, text: { type: "plain_text", text: "Approve once" }, value: message.requestId, style: "primary" },
            { type: "button", action_id: ALLOW_SIMILAR_ACTION, text: { type: "plain_text", text: "Allow similar in this Thread" }, value: message.requestId },
            { type: "button", action_id: DENY_ACTION, text: { type: "plain_text", text: "Deny" }, value: message.requestId, style: "danger" },
          ] },
        ],
      });
      if (!result.ts) throw new Error("Slack accepted the approval message but returned no ts");
      return { ts: result.ts };
    },

    async settleApproval(message: SettleApproval): Promise<void> {
      await app.client.chat.update({ channel: message.thread.channel, ts: message.ts, text: message.text, blocks: [{ type: "section", text: { type: "mrkdwn", text: message.text } }] });
    },

    async postEphemeral(message: EphemeralMessage): Promise<void> {
      await app.client.chat.postEphemeral({ channel: message.thread.channel, thread_ts: message.thread.ts, user: message.userId, text: message.text });
    },

    async updateMessage(message: UpdateMessage): Promise<void> {
      await app.client.chat.update({
        channel: message.thread.channel,
        ts: message.ts,
        // Never mix either text field with `blocks`. Slack rejects `markdown_text`
        // alongside blocks, while updating a block message with `text` removes its
        // blocks. A message therefore keeps the format it was posted with.
        ...(message.format === "markdown"
          ? { markdown_text: message.text }
          : { text: message.text }),
      });
    },

    async setStatus(status: SetStatus): Promise<void> {
      // `assistant.threads.setStatus` has accepted `chat:write` since 2026-03-05, which
      // is what lets a channel-mention bot show a native loading state without the
      // Assistant split view or the `assistant:write` scope.
      await app.client.assistant.threads.setStatus({
        channel_id: status.thread.channel,
        thread_ts: status.thread.ts,
        status: status.status,
      });
    },
  };
}

export function subscribeToMentions(app: App, mentions: MentionGateway, log: Logger): void {
  app.event("app_mention", async ({ event, body }) => {
    // Bolt has already ack'd the socket event by the time this runs.
    const delivery = await mentions.deliver(event, body);
    if (delivery.accepted) {
      // Deliberately not awaited: a Job runs for minutes or hours, and this
      // listener must return so the next event can be delivered.
      delivery.completed.catch((error: unknown) => {
        log.warn(`Job ${delivery.jobId} failed outside its own error handling: ${String(error)}`);
      });
    }
  });
}

export function subscribeToApprovalActions(
  app: App,
  decide: (click: ApprovalClick) => Promise<ApprovalClickResult>,
  log: Logger,
): void {
  const actions: readonly [string, HumanApprovalDecision][] = [
    [APPROVE_ONCE_ACTION, "approve-once"],
    [ALLOW_SIMILAR_ACTION, "allow-similar"],
    [DENY_ACTION, "deny"],
  ];
  for (const [actionId, decision] of actions) {
    app.action(actionId, async ({ ack, action, body }) => {
      await ack();
      const requestId = "value" in action && typeof action.value === "string" ? action.value : "";
      const userId = "user" in body && body.user && "id" in body.user ? String(body.user.id) : "";
      const channel = "channel" in body && body.channel && "id" in body.channel ? String(body.channel.id) : "";
      const ts = "message" in body && body.message && "thread_ts" in body.message
        ? String(body.message.thread_ts ?? "")
        : "";
      void decide({ requestId, userId, decision, thread: { channel, ts } }).catch((error: unknown) => {
        log.warn(`Approval action ${actionId} failed after acknowledgement: ${String(error)}`);
      });
    });
  }
}
