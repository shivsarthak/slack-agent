import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SessionRecord, SessionStore } from "../ports/sessions.ts";
import type { Thread } from "../thread.ts";
import type { Tenant } from "../tenant.ts";

/**
 * The Session mapping, kept in one JSON file.
 *
 * The spec leaves the concrete store to implementation: it is a small key-value
 * mapping with no queries and one writer. A file is the proportionate answer — it
 * needs no daemon for a self-hoster to run, and it is the wrapper's *only* durable
 * state, so there is nothing here to outgrow it.
 *
 * **Threads are keyed by digest, not by name.** This file would otherwise be an index
 * from Slack channel to transcript: Codex names each rollout
 * `…/sessions/<date>/rollout-<timestamp>-<session id>.jsonl`, and filesystem reads are
 * not restricted under `workspace-write` (measured — see build/02), so a plain
 * `channel → session id` mapping hands any Job a lookup table from a private channel
 * to the file holding its conversation. Hashing the key keeps the store's own job
 * intact — a Thread can find its Session, because it knows its own channel and `ts` —
 * while removing the enumeration. It is not a boundary; the transcripts are readable
 * either way. It is the difference between a lookup and a search, and it costs
 * nothing. Which Session a Thread resumed into is in the instance log, which is where
 * a human debugging this should look.
 *
 * Two properties it does have to get right, because losing it silently costs the
 * coworker its memory of a Thread:
 *
 * - **Writes replace the file atomically** — written under a unique temporary name and
 *   renamed over the original, so a crash mid-write leaves the previous mapping intact
 *   rather than a truncated file that reads as "no Thread has a Session".
 * - **Writes are serialised, and memory is updated only once the write lands.** Jobs
 *   in different Threads run concurrently and each write rewrites the whole file, so
 *   overlapping writes would otherwise be able to lose one of the two mappings — and a
 *   write that failed would otherwise leave this process claiming a Session that is not
 *   on disk.
 */

/**
 * Parsed rather than trusted: this file is read at startup and a malformed one would
 * otherwise surface as a `TypeError` deep in a Job. `z.record` also means an entry
 * added by a future version is a parse failure rather than a silent misread.
 */
const storeFileSchema = z.object({
  /** Bumped if the shape changes, so a stale file is recognised rather than misread. */
  version: z.literal(2),
  sessions: z.record(z.string(), z.object({ id: z.string(), interrupted: z.boolean() })),
});

type StoreFile = z.infer<typeof storeFileSchema>;

/**
 * Version 2 replaced the bare session id with a record, so that a Thread also
 * remembers whether its last Turn was interrupted. A version-1 file is refused rather
 * than migrated: the cost is that each Thread starts a new Session, and the honest
 * default is to make that a decision a self-hoster takes rather than one that happens
 * to them. There is no released version to have written one.
 */
const CURRENT_VERSION = 2;

/** Where the mapping lives inside the instance's state directory. */
export function sessionStoreFile(stateDir: string): string {
  return path.join(stateDir, "sessions.json");
}

export interface SessionStoreOptions {
  /** The JSON file holding the mapping. Its directory is created if it is missing. */
  filePath: string;
}

/**
 * Read the mapping from disk and return a store over it.
 *
 * Eager rather than lazy on purpose: an unreadable store means every Thread has
 * silently forgotten everything, and a self-hoster should learn that at startup
 * alongside the other preflight problems rather than from a Job that answered as if it
 * had never spoken to them before.
 */
export async function openSessionStore(options: SessionStoreOptions): Promise<SessionStore> {
  const { filePath } = options;
  const sessions = await readStore(filePath);

  // Every write rewrites the whole file, so they are chained rather than concurrent.
  let lastWrite: Promise<void> = Promise.resolve();

  return {
    async get(tenant: Tenant, thread: Thread): Promise<SessionRecord | undefined> {
      // S02 added Tenant to the digest. Fall back to the former Thread-only key so an
      // existing self-hosted installation resumes its Sessions; its next write naturally
      // records the tenant-aware key without making startup a migration operation.
      const recorded = sessions[keyFor(tenant, thread)] ?? sessions[legacyKeyFor(thread)];
      return recorded === undefined ? undefined : { ...recorded };
    },

    set(tenant: Tenant, thread: Thread, record: SessionRecord): Promise<void> {
      const key = keyFor(tenant, thread);
      lastWrite = lastWrite
        // The previous write's failure is its own caller's to report, not this one's.
        .catch(() => {})
        .then(async () => {
          const next = { ...sessions, [key]: record };
          await writeStore(filePath, {
            version: CURRENT_VERSION,
            sessions: next,
          });
          // Only now: a `get` must never claim a Session that is not on disk.
          sessions[key] = record;
        });
      return lastWrite;
    },
  };
}

/**
 * A Thread's key: the digest of both halves of its identity.
 *
 * Both halves are needed — Slack needs the channel as well as the timestamp to name a
 * Thread — and the digest is what keeps the channel out of the file. The separator is
 * a character that appears in neither, so two different Threads cannot collide by
 * concatenation.
 */
function keyFor(tenant: Tenant, thread: Thread): string {
  return createHash("sha256").update(`${tenant.id}\0${thread.channel}\0${thread.ts}`).digest("hex");
}

function legacyKeyFor(thread: Thread): string {
  return createHash("sha256").update(`${thread.channel}\0${thread.ts}`).digest("hex");
}

async function readStore(filePath: string): Promise<Record<string, SessionRecord>> {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    // A store that does not exist yet is the first run, not a problem.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (error) {
    throw unreadable(filePath, (error as Error).message);
  }

  const validated = storeFileSchema.safeParse(parsed);
  if (!validated.success) {
    throw unreadable(filePath, validated.error.issues[0]?.message ?? "unrecognised shape");
  }

  return { ...validated.data.sessions };
}

function unreadable(filePath: string, problem: string): Error {
  return new Error(
    `The Session store at ${filePath} could not be read, so every Thread would start ` +
      `over as if it had never been spoken to: ${problem}. It has not been touched — ` +
      "fix it, or delete it and accept that the coworker has forgotten every Thread.",
  );
}

async function writeStore(filePath: string, contents: StoreFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  // Unique per write: a fixed name would be shared by a second instance pointed at the
  // same state directory, and each would rename the other's half-written file into place.
  const temporary = `${filePath}.${randomUUID()}.writing`;
  try {
    await writeFile(temporary, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
    // Rename is atomic within a filesystem, so a reader never sees a partial file.
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
