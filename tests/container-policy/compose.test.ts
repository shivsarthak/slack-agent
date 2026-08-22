import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("control-plane Docker authority", () => {
  it("mounts the launcher socket, and gives the Docker socket only to the launcher", async () => {
    const compose = await readFile("compose.yaml", "utf8");
    const [control, launcher] = compose.split("  worker-launcher:");
    expect(control).toContain("launcher-socket:/run/open-agent");
    expect(control).not.toContain("docker.sock");
    expect(launcher).toContain("/var/run/docker.sock:/var/run/docker.sock");
    expect(launcher).toContain(
      "/srv/open-agent/tenants:/srv/open-agent/tenants",
    );
    expect(launcher).toContain(
      "/run/open-agent/credentials:/run/open-agent/credentials",
    );
  });
});
