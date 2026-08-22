CREATE TABLE dashboard_magic_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX dashboard_magic_links_expiry ON dashboard_magic_links (expires_at);

CREATE TABLE dashboard_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz,
  revoked_at timestamptz,
  CHECK (expires_at > created_at)
);

CREATE INDEX dashboard_sessions_user ON dashboard_sessions (user_id);
CREATE INDEX dashboard_sessions_expiry ON dashboard_sessions (expires_at);
