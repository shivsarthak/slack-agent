import type { Clock, Stoppable } from "../ports/clock.ts";
import type { Logger } from "../ports/log.ts";

export interface HostedScheduleQueue {
  reconcileMissed(nowMs: number): Promise<{ missed: number }>;
  nextDue(): Promise<number | null>;
  claimDue(
    nowMs: number,
  ): Promise<{ claimed: readonly unknown[]; overlaps: readonly unknown[] }>;
}

/** Clock-driven pump; PostgreSQL owns claims, deduplication, and Job enqueue. */
export function createHostedScheduler(input: {
  schedules: HostedScheduleQueue;
  clock: Clock;
  log: Logger;
}) {
  let timer: Stoppable | undefined;
  let ticking: Promise<void> | undefined;
  let stopped = true;

  const arm = async (): Promise<void> => {
    timer?.stop();
    timer = undefined;
    if (stopped) return;
    const due = await input.schedules.nextDue();
    if (due === null) return;
    const delay = Math.max(
      0,
      Math.min(due - input.clock.now(), 24 * 60 * 60_000),
    );
    timer = input.clock.after(delay, () =>
      scheduler.tick().catch((error) => {
        input.log.warn(`Hosted scheduler tick failed: ${String(error)}`);
      }),
    );
  };

  const scheduler = {
    async start(): Promise<void> {
      stopped = false;
      const { missed } = await input.schedules.reconcileMissed(
        input.clock.now(),
      );
      if (missed > 0)
        input.log.info(
          `Skipped ${missed} hosted Schedule Occurrence(s) missed while offline.`,
        );
      await arm();
    },
    async tick(): Promise<void> {
      if (ticking) return ticking;
      ticking = (async () => {
        await input.schedules.claimDue(input.clock.now());
        await arm();
      })().finally(() => {
        ticking = undefined;
      });
      return ticking;
    },
    async wake(): Promise<void> {
      await scheduler.tick();
    },
    stop(): void {
      stopped = true;
      timer?.stop();
      timer = undefined;
    },
  };
  return scheduler;
}
