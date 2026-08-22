import { describe, expect, it } from "vitest";
import { dockerCreateRequest } from "../../src/launcher/docker-engine.ts";
import type { ContainerSpec } from "../../src/launcher/launcher.ts";

describe("Docker Engine policy translation", () => {
  it("has no escape hatch for caller-supplied Docker fields", () => {
    const spec: ContainerSpec = {
      image: "worker@sha256:fixed",
      entrypoint: ["/worker"],
      command: ["run"],
      labels: { owner: "launcher" },
      mounts: [
        { source: "/tenant/a", target: "/work/tenant", readOnly: false },
      ],
      environment: { SECRET_FILE: "/run/secret" },
      networkMode: "none",
      readOnlyRootFilesystem: true,
      capDrop: ["ALL"],
      securityOptions: ["no-new-privileges:true"],
      memoryBytes: 1024,
      nanoCpus: 1000,
      pidsLimit: 10,
      autoRemove: false,
    };
    expect(dockerCreateRequest(spec)).toMatchSnapshot();
  });
});
