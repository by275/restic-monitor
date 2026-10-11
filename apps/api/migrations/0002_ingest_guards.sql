ALTER TABLE runs ADD COLUMN completion_fingerprint TEXT
  CHECK (completion_fingerprint IS NULL OR (
    length(completion_fingerprint) = 64
    AND completion_fingerprint NOT GLOB '*[^a-f0-9]*'
  ));

CREATE UNIQUE INDEX idx_run_repositories_run_role
  ON run_repositories(run_id, role);

CREATE TRIGGER trg_runs_identity_immutable
BEFORE UPDATE ON runs
WHEN OLD.job_id IS NOT NEW.job_id
  OR OLD.workflow_id IS NOT NEW.workflow_id
  OR OLD.operation IS NOT NEW.operation
  OR OLD.client_name IS NOT NEW.client_name
  OR OLD.client_version IS NOT NEW.client_version
  OR OLD.restic_version IS NOT NEW.restic_version
BEGIN
  SELECT RAISE(ABORT, 'run_identity_conflict');
END;

CREATE TRIGGER trg_runs_completion_immutable
BEFORE UPDATE ON runs
WHEN OLD.completion_fingerprint IS NOT NULL
  AND NEW.completion_fingerprint IS NOT OLD.completion_fingerprint
BEGIN
  SELECT RAISE(ABORT, 'run_completion_conflict');
END;
