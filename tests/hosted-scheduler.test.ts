import { describe, expect, it } from "vitest";
import { createHostedScheduler } from "../src/hosted/scheduler.ts";
import type { Clock, Stoppable } from "../src/ports/clock.ts";

class ControlledClock implements Clock {
  value = 1_000;
  pending: {
    at: number;
    tick: () => void | Promise<void>;
    stopped: boolean;
  }[] = [];
  now() {
    return this.value;
  }
  every(): Stoppable {
    throw new Error("not used");
  }
  after(delay: number, tick: () => void | Promise<void>): Stoppable {
    const item = { at: this.value + delay, tick, stopped: false };
    this.pending.push(item);
    return {
      stop: () => {
        item.stopped = true;
      },
    };
  }
  async advance(ms: number) {
    this.value += ms;
    for (const item of this.pending.filter(
      (candidate) => !candidate.stopped && candidate.at <= this.value,
    )) {
      item.stopped = true;
      await item.tick();
    }
  }
}

describe("hosted scheduler", () => {
  it("reconciles before arming and claims at the clock-controlled due instant", async () => {
    const clock = new ControlledClock();
    const events: string[] = [];
    let due: number | null = 1_500;
    const scheduler = createHostedScheduler({
      clock,
      schedules: {
        async reconcileMissed(now) {
          events.push(`reconcile:${now}`);
          return { missed: 2 };
        },
        async nextDue() {
          return due;
        },
        async claimDue(now) {
          events.push(`claim:${now}`);
          due = null;
          return { claimed: [], overlaps: [] };
        },
      },
      log: {
        info(message) {
          events.push(message);
        },
        warn(message) {
          events.push(message);
        },
      },
    });
    await scheduler.start();
    expect(events[0]).toBe("reconcile:1000");
    await clock.advance(500);
    expect(events).toContain("claim:1500");
    scheduler.stop();
  });
});
