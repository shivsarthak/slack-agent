CREATE TABLE openai_codex_onboarding_attempts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  id uuid NOT NULL,
  initiated_by_user_id uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('pending','connected','failed','cancelled','expired')),
  verification_url text,
  user_code text,
  expires_at timestamptz,
  failure text CHECK (failure IS NULL OR failure = 'provider-error'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE UNIQUE INDEX one_pending_openai_codex_onboarding_per_tenant
  ON openai_codex_onboarding_attempts (tenant_id) WHERE status = 'pending';

CREATE UNIQUE INDEX one_openai_credential_per_tenant
  ON credentials (tenant_id) WHERE kind = 'openai';
