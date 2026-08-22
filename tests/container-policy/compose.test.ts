import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

interface ComposeService {
  container_name?: string;
  depends_on?: Record<string, { condition?: string }>;
  healthcheck?: unknown;
  ports?: string[];
  volumes?: Array<{ source?: string; target?: string; type?: string }>;
}

async function renderedCompose(): Promise<{
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
}> {
  const { stdout } = await execa("docker", [
    "compose",
    "-f",
    "compose.yaml",
    "config",
    "--format",
    "json",
  ]);
  return JSON.parse(stdout) as {
    services: Record<string, ComposeService>;
    volumes: Record<string, unknown>;
  };
}

describe("hosted Compose topology", () => {
  it("renders every independently operable role with health-gated startup", async () => {
    const compose = await renderedCompose();
    expect(Object.keys(compose.services).sort()).toEqual([
      "caddy",
      "control-plane",
      "mail-sink",
      "migrate",
      "object-storage",
      "postgres",
      "worker",
      "worker-launcher",
    ]);
    for (const name of [
      "caddy",
      "control-plane",
      "mail-sink",
      "object-storage",
      "postgres",
      "worker",
      "worker-launcher",
    ]) {
      expect(compose.services[name]?.healthcheck, name).toBeDefined();
      expect(compose.services[name]?.container_name, name).toBeUndefined();
    }
    expect(
      compose.services["control-plane"]?.depends_on?.migrate?.condition,
    ).toBe("service_completed_successfully");
    expect(compose.services.worker?.depends_on?.migrate?.condition).toBe(
      "service_completed_successfully",
    );
  });

  it("keeps replicas stateless while persisting only infrastructure data", async () => {
    const compose = await renderedCompose();
    expect(compose.services["control-plane"]?.volumes ?? []).toEqual([
      expect.objectContaining({ source: "launcher-socket", type: "volume" }),
    ]);
    expect(compose.services.worker?.volumes ?? []).toEqual([]);
    expect(Object.keys(compose.volumes).sort()).toEqual([
      "caddy-config",
      "caddy-data",
      "launcher-socket",
      "object-storage-data",
      "postgres-data",
    ]);
  });
});

describe("control-plane Docker authority", () => {
  it("mounts the launcher socket, and gives the Docker socket only to the launcher", async () => {
    const compose = await readFile("compose.yaml", "utf8");
    const [control, launcher] = compose.split("\n  worker-launcher:");
    expect(control).toContain("launcher-socket:/run/open-agent");
    expect(control).not.toContain("docker.sock");
    expect(launcher).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(launcher).toContain(
      "source: ${TENANTS_ROOT:-/srv/open-agent/tenants}",
    );
    expect(launcher).toContain(
      "target: ${TENANTS_ROOT:-/srv/open-agent/tenants}",
    );
    expect(launcher).toContain("launcher-socket:/run/open-agent");
  });

  it("renders the Docker socket on the launcher alone", async () => {
    const compose = await renderedCompose();
    const socketOwners = Object.entries(compose.services)
      .filter(([, service]) =>
        service.volumes?.some(
          (mount) => mount.source === "/var/run/docker.sock",
        ),
      )
      .map(([name]) => name);
    expect(socketOwners).toEqual(["worker-launcher"]);
  });
});
