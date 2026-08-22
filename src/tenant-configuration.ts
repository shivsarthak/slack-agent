import { z } from "zod";

export const tenantConfigurationSchema = z
  .object({
    slack: z
      .object({
        teamId: z.string().min(1),
      })
      .strict()
      .optional(),
    openai: z
      .object({
        model: z.string().min(1),
      })
      .strict()
      .optional(),
    mcpServers: z.array(
      z
        .object({
          name: z.string().min(1),
          enabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();

export type TenantConfiguration = z.infer<typeof tenantConfigurationSchema>;
