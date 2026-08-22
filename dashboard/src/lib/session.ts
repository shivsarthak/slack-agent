import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Middleware and route handlers are separate bundles with separate module instances,
 * so nothing here may rely on in-process randomness: the password fallback is persisted
 * to a file and the HMAC secret is derived deterministically from the password.
 */
function resolveAdminPassword(): string {
  if (process.env.ADMIN_PASSWORD) return process.env.ADMIN_PASSWORD;
  const dir = path.join(os.tmpdir(), "open-agent-dashboard");
  const file = path.join(dir, "admin-password");
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    const generated = randomBytes(9).toString("base64url");
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, generated, { mode: 0o600 });
    console.log(
      `[dashboard] ADMIN_PASSWORD is not set — generated admin password: ${generated}`,
    );
    return generated;
  }
}

export const ADMIN_PASSWORD = resolveAdminPassword();

const secret = createHash("sha256")
  .update(`oa-dashboard-session:${process.env.SESSION_SECRET ?? ADMIN_PASSWORD}`)
  .digest();

export const SESSION_COOKIE = "oa_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function sign(payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function createToken(): string {
  const exp = String(Date.now() + SESSION_TTL_MS);
  return `${exp}.${sign(exp)}`;
}

export function verifyToken(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(payload));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  return Number(payload) > Date.now();
}

export function checkPassword(candidate: string): boolean {
  const a = Buffer.from(candidate);
  const b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}
