-- Audit events are append-only evidence. Corrections are represented by later events.
CREATE FUNCTION reject_audit_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are immutable';
END;
$$;

CREATE TRIGGER audit_events_immutable
BEFORE UPDATE OR DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE FUNCTION require_audit_event_actor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.actor_id IS NULL OR btrim(NEW.actor_id) = '' THEN
    RAISE EXCEPTION 'audit event actor is required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER audit_events_require_actor
BEFORE INSERT ON audit_events
FOR EACH ROW EXECUTE FUNCTION require_audit_event_actor();

CREATE INDEX running_jobs_by_tenant
ON jobs (tenant_id, lease_expires_at) WHERE status = 'running';

CREATE INDEX audit_events_by_job
ON audit_events (tenant_id, subject_type, subject_id, occurred_at);
