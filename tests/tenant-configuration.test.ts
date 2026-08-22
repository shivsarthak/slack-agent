import { describe, expect, it } from "vitest";
import { tenantConfigurationSchema } from "../src/tenant-configuration.ts";

describe("Tenant configuration", () => {
  it("accepts typed connector settings and rejects embedded credentials", () => {
    expect(
      tenantConfigurationSchema.parse({
        slack: { teamId: "T123" },
        openai: { model: "gpt-5" },
        mcpServers: [{ name: "github", enabled: true }],
      }),
    ).toEqual({
      slack: { teamId: "T123" },
      openai: { model: "gpt-5" },
      mcpServers: [{ name: "github", enabled: true }],
    });

    expect(() =>
      tenantConfigurationSchema.parse({
        slack: { teamId: "T123", botToken: "xoxb-plaintext" },
        mcpServers: [],
      }),
    ).toThrow();
  });
});
