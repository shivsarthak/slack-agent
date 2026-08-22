CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE slack_installations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  slack_team_id text NOT NULL UNIQUE,
  enterprise_id text,
  bot_user_id text NOT NULL,
  encrypted_bot_token text NOT NULL,
  installed_by_user_id uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE credentials (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL,
  encrypted_value text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, kind)
);

CREATE TABLE jobs (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  thread_key text NOT NULL,
  request text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting-approval','succeeded','failed','dead-letter')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0 AND attempt <= 3),
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
);

CREATE TABLE sessions (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  thread_key text NOT NULL,
  engine text NOT NULL,
  engine_session_id text NOT NULL,
  locator text NOT NULL,
  interrupted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, thread_key)
);

CREATE TABLE schedules (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  creator_user_id uuid NOT NULL REFERENCES users(id),
  task text NOT NULL,
  destination jsonb NOT NULL,
  timezone text NOT NULL,
  rule jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('active','paused','deleted')),
  next_due_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE occurrences (
  tenant_id uuid NOT NULL,
  id text NOT NULL,
  schedule_id text NOT NULL,
  job_id text,
  due_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  outcome text NOT NULL CHECK (outcome IN ('running','succeeded','failed','timed-out','skipped')),
  manual boolean NOT NULL DEFAULT false,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, schedule_id) REFERENCES schedules(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id),
  UNIQUE (tenant_id, schedule_id, due_at)
);

CREATE TABLE approvals (
  tenant_id uuid NOT NULL,
  id text NOT NULL,
  job_id text NOT NULL,
  action text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','inactive')),
  decided_by text,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES jobs(tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'pending' AND decided_at IS NULL AND decided_by IS NULL) OR
         (status IN ('approved','denied') AND decided_at IS NOT NULL AND decided_by IS NOT NULL) OR
         (status = 'inactive' AND decided_at IS NOT NULL))
);

CREATE UNIQUE INDEX one_pending_approval_per_job ON approvals (tenant_id, job_id) WHERE status = 'pending';

CREATE TABLE quotas (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id text NOT NULL,
  limit_value bigint NOT NULL CHECK (limit_value >= 0),
  used_value bigint NOT NULL DEFAULT 0 CHECK (used_value >= 0 AND used_value <= limit_value),
  period_starts_at timestamptz NOT NULL,
  period_ends_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (period_ends_at > period_starts_at)
);

CREATE TABLE audit_events (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id bigserial NOT NULL,
  actor_id text,
  event_type text NOT NULL,
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE INDEX claimable_jobs ON jobs (available_at, created_at) WHERE status = 'queued';
CREATE INDEX pending_occurrences ON schedules (next_due_at) WHERE state = 'active';
