import { existsSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { Logger } from "../ports/log.ts";

/**
 * How little free space on the sandbox filesystem is worth warning about.
 *
 * A bootstrap `pnpm install` across a monorepo reached ~3,800 packages and several gigabytes
 * of downloads before the September 2026 incident, so anything under a few gigabytes is a
 * genuine risk rather than an over-cautious number. This is a **warning**, not a refusal: a
 * self-hoster who has moved the state directory to a small volume is entitled to run that way,
 * and the check cannot know how large a Job's next install will be.
 */
const LOW_FREE_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * Report the free space on the filesystem a Job's sandbox writes to.
 *
 * The recommendation from issue #26 is to "check available bytes and inodes on the actual
 * destination filesystem before large installs". The wrapper cannot intercept an install —
 * Codex runs it — but it *does* choose the destination filesystem, so checking that once at
 * startup is the part it can honestly do. Doing it here, before the first mention, turns "a
 * Job filled the disk at 3am" into "this instance has little room left, expect failures".
 *
 * `statfs` rather than `df`: no subprocess. The measured path is the **state directory**, not
 * the sandbox's own `tmp`/`cache` leaves, for two reasons: the leaves are created lazily by
 * the first Job, and a filesystem is shared by everything under it, so the nearest existing
 * ancestor answers the same question without depending on a directory that may not exist yet.
 *
 * This is advisory throughout. A platform without `statfs`, or a path that cannot be read,
 * produces a report rather than a failure — startup must never stop over a storage hint.
 */
export async function checkSandboxStorage(deps: {
  sandboxRoot: string;
  log: Logger;
}): Promise<void> {
  const measured = nearestExistingAncestor(deps.sandboxRoot);
  let free: number;
  let total: number;
  try {
    const filesystem = await statfs(measured);
    free = filesystem.bavail * filesystem.bsize;
    total = filesystem.blocks * filesystem.bsize;
  } catch {
    deps.log.info(
      `Sandbox storage: free space under ${measured} could not be read; Jobs write their ` +
        "temporary files and package caches there, off the shared /tmp.",
    );
    return;
  }

  const location = `the filesystem holding ${measured}`;

  if (free < LOW_FREE_BYTES) {
    deps.log.warn(
      `Sandbox storage: only ${formatBytes(free)} free of ${formatBytes(total)} on ${location}. ` +
        "Jobs write temporary files and package caches here, and a dependency install can " +
        "need several gigabytes. Free space, or point stateDir at a larger volume, before " +
        "expecting large installs to succeed.",
    );
    return;
  }

  deps.log.info(
    `Sandbox storage: ${formatBytes(free)} free of ${formatBytes(total)} on ${location}. ` +
      "Temporary files and package caches from Jobs are kept here, off the shared /tmp.",
  );
}

/**
 * The deepest ancestor of `target` that exists on disk, so `statfs` measures a real
 * filesystem even when the sandbox's own directories have not been created yet.
 *
 * `stateDir` and its `sandbox` child share a filesystem, so when the child is missing the
 * parent answers the same question. This returns `target` unchanged when it already exists.
 */
function nearestExistingAncestor(target: string): string {
  let candidate = path.resolve(target);
  while (!existsSync(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate; // Reached the root and nothing exists.
    candidate = parent;
  }
  return candidate;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
