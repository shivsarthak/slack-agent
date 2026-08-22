import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLauncher,
  type ContainerEngine,
  type ContainerRecord,
  type ContainerSpec,
} from "../../src/launcher/launcher.ts";

class MemoryEngine implements ContainerEngine {
  readonly created: ContainerSpec[] = [];
  readonly records: ContainerRecord[] = [];
  async create(spec: ContainerSpec) {
    this.created.push(spec);
    const record = {
      id: `container-${this.created.length}`,
      labels: spec.labels,
      running: false,
    };
    this.records.push(record);
    return record.id;
  }
  async start(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (record) record.running = true;
  }
  async stop(id: string) {
    const record = this.records.find((item) => item.id === id);
    if (record) record.running = false;
  }
  async remove(id: string) {
    const at = this.records.findIndex((item) => item.id === id);
    if (at !== -1) this.records.splice(at, 1);
  }
  async list() {
    return [...this.records];
  }
}

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "launcher-test-"));
  roots.push(root);
  const tenantsRoot = path.join(root, "tenants");
  const credentialsRoot = path.join(root, "credentials");
  await mkdir(path.join(tenantsRoot, "tenant-a"), { recursive: true });
  await mkdir(credentialsRoot, { recursive: true });
  const engine = new MemoryEngine();
  const launcher = createLauncher({
    engine,
    tenantsRoot,
    credentialsRoot,
    now: () => new Date("2026-08-23T00:00:00.000Z"),
    limits: {
      memoryBytes: 512 * 1024 * 1024,
      nanoCpus: 500_000_000,
      pids: 128,
      timeoutMs: 60_000,
    },
    credentialFor: async () => '{"token":"tenant-secret"}',
  });
  const { realpath } = await import("node:fs/promises");
  return { engine, launcher, root: await realpath(root) };
}

describe("worker launcher policy", () => {
  it("creates only the prescribed isolated container shape", async () => {
    const { engine, launcher, root } = await setup();

    await expect(
      launcher.launch({ tenantId: "tenant-a", jobId: "job-123" }),
    ).resolves.toEqual({
      containerId: "container-1",
    });

    expect(engine.created).toEqual([
      {
        image:
          "open-agent-worker@sha256:8d8f7b87f734b09f4e9d251e36ad0c0350d9c47f8bb24cbca4f1c33e4f705f33",
        entrypoint: ["/usr/local/bin/open-agent-worker"],
        command: ["run-job", "--tenant", "tenant-a", "--job", "job-123"],
        labels: {
          "open-agent.launcher": "worker-v1",
          "open-agent.tenant": "tenant-a",
          "open-agent.job": "job-123",
          "open-agent.created-at": "2026-08-23T00:00:00.000Z",
        },
        mounts: [
          {
            source: path.join(root, "tenants", "tenant-a"),
            target: "/work/tenant",
            readOnly: false,
          },
          {
            source: path.join(root, "credentials", "tenant-a", "job-123.json"),
            target: "/run/secrets/open-agent.json",
            readOnly: true,
          },
        ],
        environment: {
          OPEN_AGENT_CREDENTIAL_FILE: "/run/secrets/open-agent.json",
        },
        networkMode: "none",
        readOnlyRootFilesystem: true,
        capDrop: ["ALL"],
        securityOptions: ["no-new-privileges:true"],
        memoryBytes: 512 * 1024 * 1024,
        nanoCpus: 500_000_000,
        pidsLimit: 128,
        autoRemove: false,
      },
    ]);
  });

  it.each([
    { tenantId: "../escape", jobId: "job-1" },
    { tenantId: "tenant-a", jobId: "../../escape" },
    { tenantId: "Tenant A", jobId: "job-1" },
    { tenantId: "tenant-a", jobId: "" },
  ])(
    "rejects malformed identifiers without touching the engine: %j",
    async (request) => {
      const { engine, launcher } = await setup();
      await expect(launcher.launch(request)).rejects.toThrow("identifier");
      expect(engine.created).toEqual([]);
    },
  );

  it("stops an owned Job and safely reconciles only stale launcher containers", async () => {
    const { engine, launcher } = await setup();
    await launcher.launch({ tenantId: "tenant-a", jobId: "job-old" });
    (engine.records[0]!.labels as Record<string, string>)[
      "open-agent.created-at"
    ] = "2026-08-22T23:58:59.000Z";
    engine.records.push({
      id: "foreign",
      running: true,
      labels: {
        "open-agent.launcher": "someone-else",
        "open-agent.created-at": "2020-01-01T00:00:00.000Z",
      },
    });

    await expect(launcher.reconcile()).resolves.toEqual({ removed: 1 });
    expect(engine.records.map(({ id }) => id)).toEqual(["foreign"]);
    await launcher.launch({ tenantId: "tenant-a", jobId: "job-new" });
    await launcher.stop({ tenantId: "tenant-a", jobId: "job-new" });
    expect(engine.records.map(({ id }) => id)).toEqual(["foreign"]);
  });

  it("enforces the Job wall-clock limit without a control-plane cleanup request", async () => {
    vi.useFakeTimers();
    const { engine, launcher } = await setup();
    await launcher.launch({ tenantId: "tenant-a", jobId: "job-timed" });
    expect(engine.records).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.records).toHaveLength(0);
  });
});
