ALTER TABLE credentials DROP CONSTRAINT credentials_tenant_id_kind_key;
ALTER TABLE credentials ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version > 0);
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('slack', 'openai', 'mcp'));

CREATE TABLE tenant_configurations (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  encrypted_value text NOT NULL,
  key_version integer NOT NULL CHECK (key_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
