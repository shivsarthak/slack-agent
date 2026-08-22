import { chmod, mkdir, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import type { LaunchRequest, Launcher } from "./launcher.ts";

export interface LauncherApiServer {
  close(): Promise<void>;
}

export async function listenLauncherApi(input: {
  socketPath: string;
  launcher: Launcher;
}): Promise<LauncherApiServer> {
  await mkdir(path.dirname(input.socketPath), { recursive: true });
  await rm(input.socketPath, { force: true });
  const server = createServer((request, response) => {
    void route(input.launcher, request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(input.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  await chmod(input.socketPath, 0o600);
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ).finally(() => rm(input.socketPath, { force: true })),
  };
}

async function route(
  launcher: Launcher,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  try {
    if (request.method === "POST" && request.url === "/v1/jobs") {
      const body = exactLaunchRequest(await readJson(request));
      return json(response, 201, await launcher.launch(body));
    }
    const match = /^\/v1\/jobs\/([^/]+)\/([^/]+)$/.exec(request.url ?? "");
    if (request.method === "DELETE" && match) {
      await launcher.stop({
        tenantId: decodeURIComponent(match[1]!),
        jobId: decodeURIComponent(match[2]!),
      });
      response.writeHead(204).end();
      return;
    }
    throw new Error("Operation is not allow-listed");
  } catch (error) {
    json(response, 400, {
      error:
        error instanceof Error ? error.message : "Invalid launcher request",
    });
  }
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (request.headers["content-type"] !== "application/json")
    throw new Error("Content-Type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > 4_096) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be JSON");
  }
}

function exactLaunchRequest(value: unknown): LaunchRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Launch request must be an object");
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "jobId,tenantId" ||
    typeof record.tenantId !== "string" ||
    typeof record.jobId !== "string"
  )
    throw new Error("Launch request has invalid fields");
  const identifier = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
  if (!identifier.test(record.tenantId) || !identifier.test(record.jobId))
    throw new Error("Launch request has invalid identifiers");
  return { tenantId: record.tenantId, jobId: record.jobId };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response
    .writeHead(status, { "content-type": "application/json" })
    .end(JSON.stringify(body));
}
