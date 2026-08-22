import { randomUUID } from "node:crypto";
import type { CredentialVault } from "../credentials/vault.ts";
import type { TenantId } from "../tenant.ts";

export const OPENAI_CODEX_CREDENTIAL_ID = "openai-codex";

export interface OpenAICodexCredential {
  readonly type: "oauth";
  readonly access: string;
  readonly refresh: string;
  readonly expires: number;
  readonly accountId?: string;
  readonly [key: string]: unknown;
}

export interface DeviceLoginNotice {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly intervalSeconds?: number;
  readonly expiresInSeconds?: number;
}

export interface OpenAICodexAuthAdapter {
  login(input: {
    signal: AbortSignal;
    onDeviceCode(event: DeviceLoginNotice): void;
  }): Promise<OpenAICodexCredential>;
  refresh(
    credential: OpenAICodexCredential,
    signal: AbortSignal,
  ): Promise<OpenAICodexCredential>;
}

export type OnboardingStatus =
  | "pending"
  | "connected"
  | "failed"
  | "cancelled"
  | "expired";

export interface OnboardingAttempt {
  readonly id: string;
  readonly tenantId: TenantId;
  readonly initiatedByUserId: string;
  readonly status: OnboardingStatus;
  readonly verificationUrl?: string;
  readonly userCode?: string;
  readonly expiresAt?: Date;
  readonly failure?: "provider-error";
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OnboardingPersistence {
  active(tenantId: TenantId): Promise<OnboardingAttempt | undefined>;
  create(record: OnboardingAttempt): Promise<OnboardingAttempt>;
  get(
    tenantId: TenantId,
    attemptId: string,
  ): Promise<OnboardingAttempt | undefined>;
  update(
    record: OnboardingAttempt,
    expectedStatus: OnboardingStatus,
  ): Promise<boolean>;
}

export interface PublicCredentialStatus {
  readonly status: "not-connected" | "connected" | "expired" | "revoked";
  readonly expiresAt?: Date;
  readonly updatedAt?: Date;
}

export class OpenAICodexOnboarding {
  private readonly tenantId: TenantId;
  private readonly attempts: OnboardingPersistence;
  private readonly vault: CredentialVault;
  private readonly adapter: OpenAICodexAuthAdapter;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly controllers = new Map<string, AbortController>();

  constructor(input: {
    tenantId: TenantId;
    attempts: OnboardingPersistence;
    vault: CredentialVault;
    adapter: OpenAICodexAuthAdapter;
    now?: () => Date;
    newId?: () => string;
  }) {
    this.tenantId = input.tenantId;
    this.attempts = input.attempts;
    this.vault = input.vault;
    this.adapter = input.adapter;
    this.now = input.now ?? (() => new Date());
    this.newId = input.newId ?? randomUUID;
  }

  async initiate(initiatedByUserId: string): Promise<OnboardingAttempt> {
    // Check the attempt first: once Pi succeeds, credential persistence precedes
    // the terminal attempt update by a few awaits. A concurrent caller must
    // still deterministically receive that in-flight attempt during the gap.
    const existing = await this.attempts.active(this.tenantId);
    if (existing) return existing;
    const existingCredential = await this.vault.inspect(
      OPENAI_CODEX_CREDENTIAL_ID,
    );
    if (existingCredential && !existingCredential.revokedAt)
      throw new Error("OpenAI Codex credential is already connected");
    const now = this.now();
    const proposed: OnboardingAttempt = {
      id: this.newId(),
      tenantId: this.tenantId,
      initiatedByUserId,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const attempt = await this.attempts.create(proposed);
    if (attempt.id === proposed.id) this.run(attempt);
    return attempt;
  }

  async status(attemptId: string): Promise<OnboardingAttempt | undefined> {
    const attempt = await this.attempts.get(this.tenantId, attemptId);
    if (
      attempt?.status === "pending" &&
      attempt.expiresAt &&
      attempt.expiresAt <= this.now()
    ) {
      const expired = {
        ...attempt,
        status: "expired" as const,
        updatedAt: this.now(),
      };
      if (await this.attempts.update(expired, "pending")) {
        this.controllers.get(attempt.id)?.abort();
        return expired;
      }
      return this.attempts.get(this.tenantId, attemptId);
    }
    return attempt;
  }

  async cancel(attemptId: string): Promise<void> {
    const attempt = await this.attempts.get(this.tenantId, attemptId);
    if (!attempt || attempt.status !== "pending") return;
    const changed = await this.attempts.update(
      { ...attempt, status: "cancelled", updatedAt: this.now() },
      "pending",
    );
    if (changed) this.controllers.get(attemptId)?.abort();
  }

  async credentialStatus(): Promise<PublicCredentialStatus> {
    const metadata = await this.vault.inspect(OPENAI_CODEX_CREDENTIAL_ID);
    if (!metadata) return { status: "not-connected" };
    if (metadata.revokedAt)
      return {
        status: "revoked",
        ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
        updatedAt: metadata.updatedAt,
      };
    return {
      status:
        metadata.expiresAt && metadata.expiresAt <= this.now()
          ? "expired"
          : "connected",
      ...(metadata.expiresAt ? { expiresAt: metadata.expiresAt } : {}),
      updatedAt: metadata.updatedAt,
    };
  }

  async refresh(): Promise<PublicCredentialStatus> {
    const stored = await this.vault.read(OPENAI_CODEX_CREDENTIAL_ID);
    if (!stored) throw new Error("OpenAI Codex credential is not connected");
    const current = parseCredential(stored.secret);
    const refreshed = await this.adapter.refresh(
      current,
      new AbortController().signal,
    );
    await this.storeCredential(refreshed);
    return this.credentialStatus();
  }

  async revoke(): Promise<PublicCredentialStatus> {
    await this.vault.revoke(OPENAI_CODEX_CREDENTIAL_ID);
    return this.credentialStatus();
  }

  private run(attempt: OnboardingAttempt): void {
    const controller = new AbortController();
    this.controllers.set(attempt.id, controller);
    void this.adapter
      .login({
        signal: controller.signal,
        onDeviceCode: (notice) => {
          void this.recordDeviceCode(attempt.id, notice).catch(() =>
            controller.abort(),
          );
        },
      })
      .then(async (credential) => {
        const current = await this.attempts.get(this.tenantId, attempt.id);
        if (!current || current.status !== "pending") return;
        await this.storeCredential(credential);
        const connected = await this.attempts.update(
          { ...current, status: "connected", updatedAt: this.now() },
          "pending",
        );
        if (!connected) await this.vault.revoke(OPENAI_CODEX_CREDENTIAL_ID);
      })
      .catch(async () => {
        const current = await this.attempts.get(this.tenantId, attempt.id);
        if (!current || current.status !== "pending") return;
        const expired =
          current.expiresAt !== undefined && current.expiresAt <= this.now();
        await this.attempts.update(
          {
            ...current,
            status: expired ? "expired" : "failed",
            ...(expired ? {} : { failure: "provider-error" as const }),
            updatedAt: this.now(),
          },
          "pending",
        );
      })
      .finally(() => this.controllers.delete(attempt.id));
  }

  private async recordDeviceCode(
    attemptId: string,
    notice: DeviceLoginNotice,
  ): Promise<void> {
    const current = await this.attempts.get(this.tenantId, attemptId);
    if (!current || current.status !== "pending") return;
    const expiresAt = new Date(
      this.now().getTime() + (notice.expiresInSeconds ?? 900) * 1_000,
    );
    await this.attempts.update(
      {
        ...current,
        verificationUrl: notice.verificationUrl,
        userCode: notice.userCode,
        expiresAt,
        updatedAt: this.now(),
      },
      "pending",
    );
  }

  private async storeCredential(credential: OpenAICodexCredential) {
    await this.vault.store({
      id: OPENAI_CODEX_CREDENTIAL_ID,
      kind: "openai",
      secret: JSON.stringify(credential),
      expiresAt: new Date(credential.expires),
    });
  }
}

function parseCredential(secret: string): OpenAICodexCredential {
  const value = JSON.parse(secret) as Partial<OpenAICodexCredential>;
  if (
    value.type !== "oauth" ||
    typeof value.access !== "string" ||
    value.access === "" ||
    typeof value.refresh !== "string" ||
    value.refresh === "" ||
    typeof value.expires !== "number" ||
    !Number.isFinite(value.expires)
  )
    throw new Error("Stored OpenAI Codex credential is invalid");
  return value as OpenAICodexCredential;
}
