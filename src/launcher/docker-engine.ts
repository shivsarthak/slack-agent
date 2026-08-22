import { request } from "node:http";
import type {
  ContainerEngine,
  ContainerRecord,
  ContainerSpec,
} from "./launcher.ts";

export function dockerEngine(
  socketPath = "/var/run/docker.sock",
): ContainerEngine {
  const call = async (
    method: string,
    route: string,
    body?: unknown,
  ): Promise<unknown> => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath,
          method,
          path: `/v1.47${route}`,
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
            // Stop is idempotent in launcher terms; Docker reports an already-stopped
            // container as 304, which must not prevent the subsequent removal.
            if (
              (incoming.statusCode ?? 500) >= 300 &&
              incoming.statusCode !== 304
            ) {
              reject(
                new Error(
                  `Docker Engine rejected ${method} ${route} (${incoming.statusCode})`,
                ),
              );
              return;
            }
            resolve(text ? JSON.parse(text) : undefined);
          });
        },
      );
      outgoing.on("error", reject);
      outgoing.end(payload);
    });
  };

  return {
    async create(spec) {
      const result = (await call(
        "POST",
        "/containers/create",
        dockerCreateRequest(spec),
      )) as {
        Id?: unknown;
      };
      if (typeof result.Id !== "string")
        throw new Error("Docker Engine returned no container id");
      return result.Id;
    },
    async start(id) {
      await call("POST", `/containers/${encodeURIComponent(id)}/start`);
    },
    async stop(id) {
      await call("POST", `/containers/${encodeURIComponent(id)}/stop?t=10`);
    },
    async remove(id) {
      await call("DELETE", `/containers/${encodeURIComponent(id)}?v=1`);
    },
    async list(): Promise<readonly ContainerRecord[]> {
      const filters = encodeURIComponent(
        JSON.stringify({ label: ["open-agent.launcher"] }),
      );
      const records = (await call(
        "GET",
        `/containers/json?all=1&filters=${filters}`,
      )) as unknown;
      if (!Array.isArray(records))
        throw new Error("Docker Engine returned an invalid container list");
      return records.map((value) => {
        const item = value as {
          Id?: unknown;
          Labels?: unknown;
          State?: unknown;
        };
        if (
          typeof item.Id !== "string" ||
          typeof item.Labels !== "object" ||
          item.Labels === null
        )
          throw new Error("Docker Engine returned invalid container metadata");
        return {
          id: item.Id,
          labels: item.Labels as Record<string, string>,
          running: item.State === "running",
        };
      });
    },
  };
}

export function dockerCreateRequest(
  spec: ContainerSpec,
): Record<string, unknown> {
  return {
    Image: spec.image,
    Entrypoint: spec.entrypoint,
    Cmd: spec.command,
    Labels: spec.labels,
    Env: Object.entries(spec.environment).map(
      ([name, value]) => `${name}=${value}`,
    ),
    HostConfig: {
      Binds: spec.mounts.map(
        (mount) =>
          `${mount.source}:${mount.target}:${mount.readOnly ? "ro" : "rw"}`,
      ),
      NetworkMode: spec.networkMode,
      ReadonlyRootfs: spec.readOnlyRootFilesystem,
      CapDrop: spec.capDrop,
      SecurityOpt: spec.securityOptions,
      Memory: spec.memoryBytes,
      NanoCpus: spec.nanoCpus,
      PidsLimit: spec.pidsLimit,
      AutoRemove: spec.autoRemove,
    },
  };
}
