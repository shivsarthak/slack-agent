import type { EngineEvent } from "../ports/engine.ts";
import type { SessionRecord, SessionStore } from "../ports/sessions.ts";
import type { Thread } from "../thread.ts";
import type { Tenant } from "../tenant.ts";

/**
 * Whether this Thread has a Turn in flight — written down, so that "in flight when
 * everything stopped" is still knowable afterwards.
 *
 * Durability is turn-granular. A completed Turn is durable and resumable; a Turn
 * interrupted partway **cannot** be resumed, and the engine keeps no trace of it — so
 * the next Job's honest reading of its own history is that the interrupted work never
 * began. It will happily push a branch that already exists.
 *
 * This is the fact that stops that, and it has to be on disk rather than in memory,
 * because the case that most needs it is the whole process dying. Set when a Turn
 * starts, cleared when one completes: anything that prevents the clearing — a bound, a
 * person typing stop, a crash, a failed Turn — leaves it set, which is exactly the set
 * of things that should warn the next Job.
 *
 * Shaped like the Reporter's two channels and the bounds: it watches the same event
 * stream and takes one thing from it. The difference is that its `observe` is awaited,
 * and deliberately — a flag that had not reached disk before the process died would be
 * a flag that fails in precisely the case it exists for.
 */
export interface TurnDurability {
  /** Fold in what the engine just did, writing when the answer changes. */
  observe(event: EngineEvent): Promise<void>;
}

export function trackTurnDurability(deps: {
  sessions: SessionStore;
  tenant: Tenant;
  thread: Thread;
  /** What this Thread already had recorded, so an unchanged flag is not rewritten. */
  known: SessionRecord | undefined;
}): TurnDurability {
  let sessionId = deps.known?.id;
  let inFlight = deps.known?.interrupted ?? false;

  const mark = async (nowInFlight: boolean): Promise<void> => {
    const id = sessionId;
    if (id === undefined || inFlight === nowInFlight) return;
    inFlight = nowInFlight;
    await deps.sessions.set(deps.tenant, deps.thread, {
      id,
      interrupted: nowInFlight,
    });
  };

  return {
    async observe(event: EngineEvent): Promise<void> {
      switch (event.type) {
        case "session-started":
          // Recorded at the first moment the Session has an identity, rather than at
          // the end of the Job: a crash after this point would otherwise orphan the
          // Session on the engine's disk and start this Thread over from nothing.
          sessionId = event.sessionId;
          await mark(true);
          break;
        case "turn-started":
          await mark(true);
          break;
        case "turn-completed":
          await mark(false);
          break;
        default:
          // Nothing else moves the Turn boundary, which is the only thing here.
          break;
      }
    },
  };
}
