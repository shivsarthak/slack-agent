import { mkdtemp } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { listenLauncherApi } from "../../src/launcher/api.ts";
import type { Launcher } from "../../src/launcher/launcher.ts";

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("allow-listed Unix-socket launcher API", () => {
  it("accepts only the launch and stop operations with an exact request shape", async () => {
    // Unix-domain socket paths are capped at roughly 100 bytes on macOS. The repository
    // verification seam deliberately uses a long, repo-local TMPDIR, so keep this fixture
    // at the operating system's short temporary alias.
    const root = await mkdtemp("/tmp/launcher-api-");
    roots.push(root);
    const socket = path.join(root, "launcher.sock");
    const launcher: Launcher = {
      launch: vi.fn(async () => ({ containerId: "container-1" })),
      stop: vi.fn(async () => undefined),
      reconcile: vi.fn(async () => ({ removed: 0 })),
    };
    const server = await listenLauncherApi({ socketPath: socket, launcher });
    try {
      await expect(
        call(socket, "POST", "/v1/jobs", {
          tenantId: "tenant-a",
          jobId: "job-1",
        }),
      ).resolves.toMatchObject({
        status: 201,
        body: { containerId: "container-1" },
      });
      await expect(
        call(socket, "DELETE", "/v1/jobs/tenant-a/job-1"),
      ).resolves.toMatchObject({ status: 204 });
      for (const adversarial of [
        call(socket, "GET", "/containers/json"),
        call(socket, "POST", "/v1/jobs", {
          tenantId: "tenant-a",
          jobId: "job-2",
          image: "evil",
        }),
        call(socket, "POST", "/v1/jobs", {
          tenantId: "../escape",
          jobId: "job-2",
        }),
        call(socket, "POST", "/v1/jobs", "not-json"),
      ])
        await expect(adversarial).resolves.toMatchObject({ status: 400 });
      expect(launcher.launch).toHaveBeenCalledTimes(1);
      expect(launcher.stop).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });
});

function call(
  socketPath: string,
  method: string,
  pathName: string,
  body?: unknown,
) {
  return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const payload =
      body === undefined
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);
    const outgoing = request(
      {
        socketPath,
        path: pathName,
        method,
        headers: payload
          ? {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(payload),
            }
          : {},
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(chunk));
        incoming.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: incoming.statusCode ?? 0,
            body: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}
