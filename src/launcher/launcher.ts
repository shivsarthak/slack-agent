import { lstat, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const OWNER = "worker-v1";
const IMAGE =
  "open-agent-worker@sha256:8d8f7b87f734b09f4e9d251e36ad0c0350d9c47f8bb24cbca4f1c33e4f705f33";
const ID = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

export interface ContainerMount {
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export interface ContainerSpec {
  readonly image: string;
  readonly entrypoint: readonly string[];
  readonly command: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
  readonly mounts: readonly ContainerMount[];
  readonly environment: Readonly<Record<string, string>>;
  readonly networkMode: "none";
  readonly readOnlyRootFilesystem: true;
  readonly capDrop: readonly ["ALL"];
  readonly securityOptions: readonly ["no-new-privileges:true"];
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pidsLimit: number;
  readonly autoRemove: false;
}

export interface ContainerRecord {
  readonly id: string;
  readonly labels: Readonly<Record<string, string>>;
  running: boolean;
}

export interface ContainerEngine {
  create(spec: ContainerSpec): Promise<string>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(): Promise<readonly ContainerRecord[]>;
}

export interface LauncherLimits {
  readonly memoryBytes: number;
  readonly nanoCpus: number;
  readonly pids: number;
  readonly timeoutMs: number;
}

export interface LaunchRequest {
  readonly tenantId: string;
  readonly jobId: string;
}

export interface Launcher {
  launch(request: LaunchRequest): Promise<{ containerId: string }>;
  stop(request: LaunchRequest): Promise<void>;
  reconcile(): Promise<{ removed: number }>;
}

export function createLauncher(deps: {
  engine: ContainerEngine;
  tenantsRoot: string;
  credentialsRoot: string;
  limits: LauncherLimits;
  credentialFor(tenantId: string): Promise<string>;
  now?: () => Date;
}): Launcher {
  const now = deps.now ?? (() => new Date());
  const pending = new Set<string>();
  const expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  validateLimits(deps.limits);

  const owned = async (request: LaunchRequest) => {
    validateRequest(request);
    return (await deps.engine.list()).filter(
      (item) =>
        item.labels["open-agent.launcher"] === OWNER &&
        item.labels["open-agent.tenant"] === request.tenantId &&
        item.labels["open-agent.job"] === request.jobId,
    );
  };

  const remove = async (record: ContainerRecord): Promise<void> => {
    const timer = expiryTimers.get(record.id);
    if (timer) clearTimeout(timer);
    expiryTimers.delete(record.id);
    if (record.running) await deps.engine.stop(record.id);
    await deps.engine.remove(record.id);
    const tenant = record.labels["open-agent.tenant"];
    const job = record.labels["open-agent.job"];
    if (tenant && job && ID.test(tenant) && ID.test(job)) {
      await rm(path.join(deps.credentialsRoot, tenant, `${job}.json`), {
        force: true,
      });
    }
  };

  return {
    async launch(request) {
      validateRequest(request);
      const key = `${request.tenantId}/${request.jobId}`;
      if (pending.has(key) || (await owned(request)).length !== 0)
        throw new Error("A container already exists for this Tenant and Job");
      pending.add(key);
      try {
        const tenantRoot = await existingChild(
          deps.tenantsRoot,
          request.tenantId,
        );
        const credentialDirectory = await safeCredentialDirectory(
          deps.credentialsRoot,
          request.tenantId,
        );
        const credentialFile = path.join(
          credentialDirectory,
          `${request.jobId}.json`,
        );
        await writeFile(
          credentialFile,
          await deps.credentialFor(request.tenantId),
          {
            mode: 0o600,
            flag: "wx",
          },
        );

        const createdAt = now();
        let containerId: string | undefined;
        try {
          containerId = await deps.engine.create({
            image: IMAGE,
            entrypoint: ["/usr/local/bin/open-agent-worker"],
            command: [
              "run-job",
              "--tenant",
              request.tenantId,
              "--job",
              request.jobId,
            ],
            labels: {
              "open-agent.launcher": OWNER,
              "open-agent.tenant": request.tenantId,
              "open-agent.job": request.jobId,
              "open-agent.created-at": createdAt.toISOString(),
            },
            mounts: [
              { source: tenantRoot, target: "/work/tenant", readOnly: false },
              {
                source: credentialFile,
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
            memoryBytes: deps.limits.memoryBytes,
            nanoCpus: deps.limits.nanoCpus,
            pidsLimit: deps.limits.pids,
            autoRemove: false,
          });
          await deps.engine.start(containerId);
          const timer = setTimeout(() => {
            void owned(request)
              .then(async (records) => {
                for (const record of records) await remove(record);
              })
              .catch(() => undefined);
          }, deps.limits.timeoutMs);
          timer.unref();
          expiryTimers.set(containerId, timer);
          return { containerId };
        } catch (error) {
          if (containerId)
            await deps.engine.remove(containerId).catch(() => undefined);
          await rm(credentialFile, { force: true });
          throw error;
        }
      } finally {
        pending.delete(key);
      }
    },

    async stop(request) {
      for (const record of await owned(request)) await remove(record);
    },

    async reconcile() {
      const cutoff = now().getTime() - deps.limits.timeoutMs;
      let removed = 0;
      for (const record of await deps.engine.list()) {
        if (record.labels["open-agent.launcher"] !== OWNER) continue;
        const createdAt = Date.parse(
          record.labels["open-agent.created-at"] ?? "",
        );
        if (!Number.isFinite(createdAt) || createdAt > cutoff) continue;
        await remove(record);
        removed++;
      }
      return { removed };
    },
  };
}

function validateRequest(request: LaunchRequest): void {
  if (!ID.test(request.tenantId) || !ID.test(request.jobId)) {
    throw new Error(
      "Tenant and Job identifiers must be lowercase safe identifiers",
    );
  }
}

function validateLimits(limits: LauncherLimits): void {
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error("Launcher limits must be positive integers");
  }
}

async function existingChild(root: string, child: string): Promise<string> {
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(path.join(canonicalRoot, child));
  if (!candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
    throw new Error("Tenant mount escapes the storage root");
  }
  return candidate;
}

async function safeCredentialDirectory(
  root: string,
  child: string,
): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const candidate = path.join(canonicalRoot, child);
  try {
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink() || !metadata.isDirectory())
      throw new Error("Credential directory is unsafe");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await mkdir(candidate, { mode: 0o700 });
  }
  const canonical = await realpath(candidate);
  if (!canonical.startsWith(`${canonicalRoot}${path.sep}`))
    throw new Error("Credential directory escapes its storage root");
  return canonical;
}
