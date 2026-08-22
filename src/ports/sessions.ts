import type { Thread } from "../thread.ts";
import type { Tenant } from "../tenant.ts";

/**
 * **The wrapper's only durable state**, in one record per Thread.
 *
 * Codex owns Session content as append-only rollouts on its own disk, and Notes are
 * files in the Vault. So there is nothing else for this project to persist — which is
 * why what a Thread carries between Jobs is two small facts and not a conversation.
 */
export interface SessionRecord {
  /** The engine's identifier for this Thread's Session. */
  id: string;
  /** Adapter discriminator used by hosted composition when selecting an engine. */
  engine?: string;
  /** Opaque engine-owned value used to reopen persisted Session content. */
  locator?: string;
  /**
   * A Turn started in this Session and was never seen to finish.
   *
   * Durability is turn-granular: a completed Turn is durable and resumable, and a
   * Turn interrupted partway cannot be resumed and **may have landed some of its side
   * effects**. Which of those happened is not knowable from here, so it is recorded
   * rather than inferred — set when a Turn starts, cleared when one completes, and
   * therefore still true on disk if the whole process died in between.
   *
   * The next Job in this Thread is told, so it verifies state before pushing a branch
   * that already exists or filing a ticket that is already filed.
   */
  interrupted: boolean;
}

/**
 * Where {@link SessionRecord}s live between Jobs.
 *
 * Two methods, keyed by Tenant and Thread, storing identifiers rather than conversation. If a
 * future ticket finds itself wanting to keep transcripts here, that is the signal to
 * reread ADR-0003 rather than to widen this interface.
 */
export interface SessionStore {
  /** What is recorded for this Thread, or undefined if it has no Session yet. */
  get(tenant: Tenant, thread: Thread): Promise<SessionRecord | undefined>;
  /**
   * Record this Thread's Session.
   *
   * Written by the time it resolves, and written such that this process dying
   * afterwards still leaves the Thread resumable. That is a promise about *this
   * process*, not about the host: the write is atomically replaced rather than
   * `fsync`ed, so a machine losing power may still lose the most recent mapping. The
   * cost of that is one Thread starting over, which is not worth an `fsync` on every
   * Job — but it is worth stating rather than implying.
   */
  set(tenant: Tenant, thread: Thread, record: SessionRecord): Promise<void>;
}
