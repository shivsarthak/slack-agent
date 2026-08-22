import {
  bigint,
  bigserial,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
};

export const users = pgTable("users", {
  id: uuid().primaryKey(),
  email: text().notNull().unique(),
  displayName: text("display_name"),
  createdAt: timestamps.createdAt,
});
export const tenants = pgTable("tenants", {
  id: uuid().primaryKey(),
  name: text().notNull(),
  createdAt: timestamps.createdAt,
});
export const memberships = pgTable(
  "memberships",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text().notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.userId] })],
);
export const dashboardMagicLinks = pgTable("dashboard_magic_links", {
  tokenHash: text("token_hash").primaryKey(),
  email: text().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamps.createdAt,
});
export const dashboardSessions = pgTable("dashboard_sessions", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamps.createdAt,
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});
export const slackInstallations = pgTable(
  "slack_installations",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    slackTeamId: text("slack_team_id").notNull().unique(),
    teamName: text("team_name").notNull(),
    enterpriseId: text("enterprise_id"),
    botUserId: text("bot_user_id").notNull(),
    encryptedBotToken: text("encrypted_bot_token").notNull(),
    installedByUserId: uuid("installed_by_user_id").references(() => users.id),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique().on(table.tenantId),
  ],
);
export const slackOauthStates = pgTable(
  "slack_oauth_states",
  {
    stateHash: text("state_hash").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("slack_oauth_states_expiry").on(table.expiresAt)],
);
export const slackDeliveries = pgTable(
  "slack_deliveries",
  {
    deliveryKey: text("delivery_key").primaryKey(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (table) => [index("slack_deliveries_expiry").on(table.expiresAt)],
);
export const credentials = pgTable(
  "credentials",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    kind: text().notNull(),
    encryptedValue: text("encrypted_value").notNull(),
    keyVersion: integer("key_version").notNull(),
    version: integer().notNull().default(1),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);
export const tenantConfigurations = pgTable("tenant_configurations", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id, { onDelete: "cascade" }),
  version: integer().notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  keyVersion: integer("key_version").notNull(),
  ...timestamps,
});
export const jobs = pgTable(
  "jobs",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    threadKey: text("thread_key").notNull(),
    request: text().notNull(),
    status: text().notNull().default("queued"),
    attempt: integer().notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    idempotencyKey: text("idempotency_key").notNull(),
    lastError: text("last_error"),
    cancelledBy: text("cancelled_by"),
    cancelledReason: text("cancelled_reason"),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    replayOf: text("replay_of"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    index("claimable_jobs").on(table.availableAt, table.createdAt),
  ],
);
export const sessions = pgTable(
  "sessions",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    threadKey: text("thread_key").notNull(),
    engine: text().notNull(),
    engineSessionId: text("engine_session_id").notNull(),
    locator: text().notNull(),
    interrupted: boolean().notNull().default(false),
    ...timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique().on(table.tenantId, table.threadKey),
  ],
);
export const schedules = pgTable(
  "schedules",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    creatorUserId: uuid("creator_user_id")
      .notNull()
      .references(() => users.id),
    task: text().notNull(),
    destination: jsonb().notNull(),
    timezone: text().notNull(),
    rule: jsonb().notNull(),
    state: text().notNull(),
    nextDueAt: timestamp("next_due_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);
export const occurrences = pgTable(
  "occurrences",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: text().notNull(),
    scheduleId: text("schedule_id").notNull(),
    jobId: text("job_id"),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    outcome: text().notNull(),
    manual: boolean().notNull().default(false),
    details: jsonb().notNull().default({}),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    unique().on(table.tenantId, table.scheduleId, table.dueAt),
    foreignKey({
      columns: [table.tenantId, table.scheduleId],
      foreignColumns: [schedules.tenantId, schedules.id],
    }),
    foreignKey({
      columns: [table.tenantId, table.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
  ],
);
export const approvals = pgTable(
  "approvals",
  {
    tenantId: uuid("tenant_id").notNull(),
    id: text().notNull(),
    jobId: text("job_id").notNull(),
    action: text().notNull(),
    status: text().notNull().default("pending"),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.id] }),
    foreignKey({
      columns: [table.tenantId, table.jobId],
      foreignColumns: [jobs.tenantId, jobs.id],
    }),
  ],
);
export const quotas = pgTable(
  "quotas",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: text().notNull(),
    limitValue: bigint("limit_value", { mode: "number" }).notNull(),
    usedValue: bigint("used_value", { mode: "number" }).notNull().default(0),
    periodStartsAt: timestamp("period_starts_at", {
      withTimezone: true,
    }).notNull(),
    periodEndsAt: timestamp("period_ends_at", { withTimezone: true }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);
export const auditEvents = pgTable(
  "audit_events",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    id: bigserial({ mode: "number" }).notNull(),
    actorId: text("actor_id"),
    eventType: text("event_type").notNull(),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    payload: jsonb().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.tenantId, table.id] })],
);
