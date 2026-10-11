DROP INDEX IF EXISTS idx_runs_job_started;
DROP INDEX IF EXISTS idx_runs_status_started;
DROP INDEX IF EXISTS idx_repository_stats_repository_measured;

CREATE INDEX idx_runs_started_id
  ON runs(started_at DESC, id DESC);
CREATE INDEX idx_runs_job_started
  ON runs(job_id, started_at DESC, id DESC);
CREATE INDEX idx_runs_status_started
  ON runs(status, started_at DESC, id DESC);
CREATE INDEX idx_hosts_enabled_created
  ON hosts(enabled, created_at ASC, id ASC);
CREATE INDEX idx_repositories_enabled_key
  ON repositories(enabled, repository_key ASC, id ASC);
CREATE INDEX idx_repositories_backend_key
  ON repositories(backend_type, repository_key ASC, id ASC);
CREATE INDEX idx_repository_stats_repository_measured
  ON repository_stats(repository_id, measured_at DESC, id DESC);
