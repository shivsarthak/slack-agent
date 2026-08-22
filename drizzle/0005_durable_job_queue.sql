ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs
  ADD CONSTRAINT jobs_status_check CHECK (status IN ('queued','running','waiting-approval','succeeded','failed','dead-letter','cancelled')),
  ADD COLUMN idempotency_key text,
  ADD COLUMN lease_token uuid,
  ADD COLUMN last_error text,
  ADD COLUMN cancelled_by text,
  ADD COLUMN cancelled_reason text,
  ADD COLUMN cancelled_at timestamptz,
  ADD COLUMN replay_of text,
  ADD CONSTRAINT jobs_replay_of FOREIGN KEY (tenant_id, replay_of) REFERENCES jobs(tenant_id, id),
  ADD CONSTRAINT jobs_lease_shape CHECK (
    (status = 'running' AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL AND lease_token IS NOT NULL)
    OR (status <> 'running' AND lease_owner IS NULL AND lease_expires_at IS NULL AND lease_token IS NULL)
  );

UPDATE jobs SET idempotency_key = id;
ALTER TABLE jobs ALTER COLUMN idempotency_key SET NOT NULL;
CREATE UNIQUE INDEX jobs_idempotency ON jobs (tenant_id, idempotency_key);
CREATE UNIQUE INDEX one_running_job_per_thread ON jobs (tenant_id, thread_key)
  WHERE status = 'running';
DROP INDEX claimable_jobs;
CREATE INDEX claimable_jobs ON jobs (available_at, created_at)
  WHERE status IN ('queued', 'running');
