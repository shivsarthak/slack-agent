import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { composeHostedTenant } from "../src/hosted/composition.ts";
import { composeSelfHosted } from "../src/self-hosted/composition.ts";
import { tenantId } from "../src/tenant.ts";
import { openSessionStore, sessionStoreFile } from "../src/sessions/store.ts";
import { coworkerHarness } from "./support/harness.ts";

describe("Tenant-aware domain composition", () => {
  it("maps a self-hosted workspace to one explicit Tenant", async () => {
    const { deps } = await coworkerHarness();

    const composed = composeSelfHosted({ workspaceId: "T_SELF_HOSTED", deps });

    expect(composed.tenant).toEqual({ id: "T_SELF_HOSTED" });
    expect(composed.coworker.tenant).toEqual(composed.tenant);
  });

  it("uses the same Job pipeline for a hosted Tenant", async () => {
    const { deps } = await coworkerHarness();
    const tenant = { id: tenantId("tenant-acme") };

    const composed = composeHostedTenant({ tenant, deps });

    expect(composed.tenant).toBe(tenant);
    expect(composed.coworker.tenant).toBe(tenant);
    expect(Object.keys(composed.coworker).sort()).toEqual(
      Object.keys(composeSelfHosted({ workspaceId: "T_SELF_HOSTED", deps }).coworker).sort(),
    );
  });

  it("rejects an empty Tenant identity at the public boundary", () => {
    expect(() => tenantId("   ")).toThrow(/Tenant identity/i);
  });

  it("keeps the same Slack Thread separate in a tenant-scoped port", async () => {
    const { deps } = await coworkerHarness();
    const thread = { channel: "C_SHARED", ts: "1700000000.000100" };
    const acme = { id: tenantId("tenant-acme") };
    const other = { id: tenantId("tenant-other") };

    await deps.sessions.set(acme, thread, {
      id: "session-acme",
      interrupted: false,
    });
    await deps.sessions.set(other, thread, {
      id: "session-other",
      interrupted: false,
    });

    await expect(deps.sessions.get(acme, thread)).resolves.toMatchObject({
      id: "session-acme",
    });
    await expect(deps.sessions.get(other, thread)).resolves.toMatchObject({
      id: "session-other",
    });
  });

  it("retains a self-hosted Thread's Session when Tenant identity is introduced", async () => {
    const { stateDir } = await coworkerHarness();
    const thread = { channel: "C_EXISTING", ts: "1700000000.000100" };
    const legacyKey = createHash("sha256").update(`${thread.channel}\0${thread.ts}`).digest("hex");
    const filePath = sessionStoreFile(path.join(stateDir, "legacy"));
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 2,
        sessions: { [legacyKey]: { id: "existing-session", interrupted: false } },
      }),
    );
    const sessions = await openSessionStore({ filePath });

    await expect(sessions.get({ id: tenantId("self-hosted") }, thread)).resolves.toMatchObject({
      id: "existing-session",
    });
  });
});
