CREATE TABLE organization_skill_author_updates (
  tenant_id text NOT NULL REFERENCES tenants(tenant_id) ON DELETE CASCADE,
  update_id uuid NOT NULL,
  recipient_user_id text NOT NULL,
  submission_id uuid NOT NULL,
  attempt integer NOT NULL CHECK (attempt > 0),
  kind text NOT NULL CHECK (kind IN ('changes_requested','declined','accepted','released')),
  skill_name text NOT NULL,
  feedback text,
  organization_skill_id text,
  organization_revision_id bigint,
  audience text CHECK (audience IN ('test-users','members')),
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  PRIMARY KEY (tenant_id, update_id),
  FOREIGN KEY (tenant_id, submission_id, attempt)
    REFERENCES organization_skill_submission_attempts(tenant_id, submission_id, attempt) ON DELETE CASCADE,
  CHECK ((kind = 'released') = (audience IS NOT NULL)),
  CHECK (length(skill_name) <= 64),
  CHECK (feedback IS NULL OR length(feedback) <= 4000)
);

UPDATE admin_skill_revisions r SET validation_status=CASE
  WHEN jsonb_array_length(r.validation_messages)>0 THEN 'validated_with_warnings'
  ELSE 'validated' END
FROM organization_skill_submission_attempts a
WHERE a.tenant_id=r.tenant_id AND a.accepted_revision_id=r.skill_revision_id
  AND a.status='accepted' AND r.validation_status='valid';

CREATE UNIQUE INDEX organization_skill_author_updates_event_idx
  ON organization_skill_author_updates(tenant_id, submission_id, attempt)
  WHERE kind IN ('changes_requested','declined','accepted');
CREATE INDEX organization_skill_author_updates_recipient_idx
  ON organization_skill_author_updates(tenant_id, recipient_user_id, created_at DESC, update_id DESC);
CREATE INDEX organization_skill_author_updates_unread_idx
  ON organization_skill_author_updates(tenant_id, recipient_user_id) WHERE read_at IS NULL;

ALTER TABLE organization_skill_author_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_skill_author_updates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON organization_skill_author_updates
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));

CREATE FUNCTION enforce_organization_skill_author_update_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.update_id, NEW.recipient_user_id, NEW.submission_id, NEW.attempt,
      NEW.kind, NEW.skill_name, NEW.feedback, NEW.organization_skill_id,
      NEW.organization_revision_id, NEW.audience, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.update_id, OLD.recipient_user_id, OLD.submission_id, OLD.attempt,
      OLD.kind, OLD.skill_name, OLD.feedback, OLD.organization_skill_id,
      OLD.organization_revision_id, OLD.audience, OLD.created_at)
     OR (OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at) THEN
    RAISE EXCEPTION 'Author update events are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER organization_skill_author_update_immutable
  BEFORE UPDATE ON organization_skill_author_updates
  FOR EACH ROW EXECUTE FUNCTION enforce_organization_skill_author_update_immutable();

INSERT INTO organization_skill_author_updates
  (tenant_id, update_id, recipient_user_id, submission_id, attempt, kind, skill_name,
   feedback, organization_skill_id, organization_revision_id, created_at)
SELECT s.tenant_id,
  gen_random_uuid(),
  s.author_user_id, s.submission_id, a.attempt, a.status,
  CASE WHEN a.status = 'accepted' THEN COALESCE(r.metadata->>'skillName', a.source_name)
    ELSE a.source_name END,
  a.feedback, CASE WHEN a.status = 'accepted' THEN s.accepted_skill_id ELSE NULL END,
  a.accepted_revision_id, a.decided_at
FROM organization_skill_submission_attempts a
JOIN organization_skill_submissions s ON s.tenant_id = a.tenant_id AND s.submission_id = a.submission_id
LEFT JOIN admin_skill_revisions r ON r.tenant_id = a.tenant_id AND r.skill_revision_id = a.accepted_revision_id
WHERE a.status IN ('changes_requested','declined','accepted') AND a.decided_at IS NOT NULL;

INSERT INTO organization_skill_author_updates
  (tenant_id, update_id, recipient_user_id, submission_id, attempt, kind, skill_name,
   feedback, organization_skill_id, organization_revision_id, audience, created_at)
SELECT s.tenant_id, gen_random_uuid(), s.author_user_id, s.submission_id, s.latest_attempt,
  'released', COALESCE(r.metadata->>'skillName', ar.source_name), NULL,
  s.accepted_skill_id, r.skill_revision_id, e.payload->>'audience', e.created_at
FROM audit_events e
JOIN organization_skill_submissions s ON s.tenant_id=e.tenant_id
  AND s.submission_id::text=e.payload->>'submissionId'
JOIN organization_skill_submission_attempts ar ON ar.tenant_id=s.tenant_id
  AND ar.submission_id=s.submission_id AND ar.attempt=s.latest_attempt
JOIN admin_skill_revisions r ON r.tenant_id=s.tenant_id
  AND r.skill_revision_id::text=e.payload->>'revisionId'
  AND r.skill_id=s.accepted_skill_id
WHERE e.event_type='organization.skill_submission.released'
  AND e.payload->>'audience' IN ('test-users','members')
  AND e.payload->>'organizationSkillId'=s.accepted_skill_id
  AND s.status='accepted'
ON CONFLICT DO NOTHING;
