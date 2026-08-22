ALTER TABLE slack_installations ADD COLUMN team_name text NOT NULL DEFAULT '';
ALTER TABLE slack_installations ADD CONSTRAINT slack_installations_one_workspace_per_tenant UNIQUE (tenant_id);

CREATE TABLE slack_oauth_states (
  state_hash text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE slack_deliveries (
  delivery_key text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX slack_oauth_states_expiry ON slack_oauth_states(expires_at);
CREATE INDEX slack_deliveries_expiry ON slack_deliveries(expires_at);
