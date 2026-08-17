import { defineConfig } from "vitest/config";

// The contract seam: slow, opt-in tests that run a real Codex App Server. This is the
// only place a fake can drift from reality, and with no Codex version pin in v1 it
// is the safety net standing between an upstream alpha and a silently broken
// instance. Run it against whatever version is installed, not only at a bump.
export default defineConfig({
  test: {
    include: ["tests/contract/**/*.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // A real agent process per test; running them in parallel would race on the
    // same Codex auth and session storage.
    fileParallelism: false,
  },
});
