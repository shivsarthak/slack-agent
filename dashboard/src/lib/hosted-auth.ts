import { Pool } from "pg";
import {
  createDashboardAuth,
  createDashboardAuthHttpHandler,
  type MailMessage,
  type MailPort,
} from "@agent/dashboard/auth.ts";

const globalAuth = globalThis as typeof globalThis & {
  openAgentDashboardPool?: Pool;
  openAgentLastMagicLink?: MailMessage;
};

export const dashboardPool =
  globalAuth.openAgentDashboardPool ??
  new Pool({ connectionString: process.env.DATABASE_URL });
if (process.env.NODE_ENV !== "production")
  globalAuth.openAgentDashboardPool = dashboardPool;

const developmentMail: MailPort = {
  async send(message) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("A production MailPort must be configured");
    }
    globalAuth.openAgentLastMagicLink = message;
    console.info(
      `[dashboard] magic link for ${message.to}: ${message.magicLink}`,
    );
  },
};

export const dashboardAuth = createDashboardAuth({
  pool: dashboardPool,
  mail: developmentMail,
  publicUrl: process.env.DASHBOARD_PUBLIC_URL ?? "http://localhost:3100",
});

export const handleDashboardAuth =
  createDashboardAuthHttpHandler(dashboardAuth);
