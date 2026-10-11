CREATE TABLE hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY NOT NULL,
  repository_key TEXT NOT NULL UNIQUE CHECK (length(repository_key) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  backend_type TEXT NOT NULL CHECK (backend_type IN ('local', 'sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'other')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
  job_key TEXT NOT NULL CHECK (length(job_key) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  schedule TEXT NOT NULL CHECK (length(schedule) BETWEEN 1 AND 128),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  grace_seconds INTEGER NOT NULL DEFAULT 0 CHECK (grace_seconds >= 0),
  timeout_seconds INTEGER NOT NULL CHECK (timeout_seconds > 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  UNIQUE (host_id, job_key)
);

CREATE TABLE job_repositories (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('repository', 'source', 'target')),
  PRIMARY KEY (job_id, repository_id, role)
);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 1 AND 24),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  scopes_json TEXT NOT NULL CHECK (length(scopes_json) <= 4096 AND json_valid(scopes_json)),
  expires_at INTEGER,
  revoked_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 1 AND 64),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  workflow_id TEXT CHECK (workflow_id IS NULL OR length(workflow_id) BETWEEN 1 AND 64),
  operation TEXT NOT NULL CHECK (operation IN ('backup', 'forget', 'prune', 'forget_prune', 'copy', 'stats', 'check', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial_success', 'failed', 'timed_out', 'cancelled')),
  exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
  client_name TEXT NOT NULL CHECK (length(client_name) BETWEEN 1 AND 64),
  client_version TEXT NOT NULL CHECK (length(client_version) BETWEEN 1 AND 64),
  restic_version TEXT CHECK (restic_version IS NULL OR length(restic_version) BETWEEN 1 AND 64),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  error_summary TEXT CHECK (error_summary IS NULL OR length(error_summary) <= 1024),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status <> 'running' AND finished_at IS NOT NULL)
  )
);

CREATE TABLE run_repositories (
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('repository', 'source', 'target')),
  PRIMARY KEY (run_id, repository_id, role)
);

CREATE TABLE run_metrics (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  bytes_processed INTEGER CHECK (bytes_processed IS NULL OR bytes_processed BETWEEN 0 AND 9007199254740991),
  bytes_added INTEGER CHECK (bytes_added IS NULL OR bytes_added BETWEEN 0 AND 9007199254740991),
  bytes_added_packed INTEGER CHECK (bytes_added_packed IS NULL OR bytes_added_packed BETWEEN 0 AND 9007199254740991),
  files_new INTEGER CHECK (files_new IS NULL OR files_new BETWEEN 0 AND 9007199254740991),
  files_changed INTEGER CHECK (files_changed IS NULL OR files_changed BETWEEN 0 AND 9007199254740991),
  files_unmodified INTEGER CHECK (files_unmodified IS NULL OR files_unmodified BETWEEN 0 AND 9007199254740991),
  snapshot_id TEXT CHECK (snapshot_id IS NULL OR (length(snapshot_id) BETWEEN 8 AND 64 AND snapshot_id NOT GLOB '*[^a-fA-F0-9]*')),
  metrics_json TEXT NOT NULL DEFAULT '{}' CHECK (length(metrics_json) <= 32768 AND json_valid(metrics_json)),
  updated_at INTEGER NOT NULL
);

CREATE TABLE ingest_events (
  token_id TEXT NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL CHECK (length(event_id) BETWEEN 1 AND 64),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 64),
  event_type TEXT NOT NULL CHECK (event_type IN ('run.started', 'run.completed')),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^a-f0-9]*'),
  received_at INTEGER NOT NULL,
  PRIMARY KEY (token_id, event_id)
);

CREATE TABLE repository_stats (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  measurement_type TEXT NOT NULL CHECK (measurement_type IN ('restic_restore_size', 'restic_raw_data', 'restic_total_size', 'backend_physical_bytes')),
  value_bytes INTEGER NOT NULL CHECK (value_bytes BETWEEN 0 AND 9007199254740991),
  measured_at INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (length(details_json) <= 8192 AND json_valid(details_json)),
  created_at INTEGER NOT NULL
);

CREATE TABLE schedule_occurrences (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'matched', 'missed')),
  matched_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (job_id, scheduled_for)
);

CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  rule_key TEXT NOT NULL CHECK (length(rule_key) BETWEEN 1 AND 64),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'suppressed')),
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  occurrence_job_id TEXT,
  occurrence_scheduled_for INTEGER,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1024),
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (occurrence_job_id, occurrence_scheduled_for)
    REFERENCES schedule_occurrences(job_id, scheduled_for) ON DELETE SET NULL,
  CHECK ((occurrence_job_id IS NULL) = (occurrence_scheduled_for IS NULL))
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL CHECK (length(channel_key) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (alert_id, channel_key)
);

CREATE INDEX idx_jobs_enabled ON jobs(enabled, host_id);
CREATE INDEX idx_runs_job_started ON runs(job_id, started_at DESC);
CREATE INDEX idx_runs_status_started ON runs(status, started_at DESC);
CREATE INDEX idx_run_repositories_repository_run ON run_repositories(repository_id, run_id);
CREATE INDEX idx_ingest_events_received ON ingest_events(received_at);
CREATE INDEX idx_repository_stats_repository_measured ON repository_stats(repository_id, measured_at DESC);
CREATE INDEX idx_schedule_occurrences_state_time ON schedule_occurrences(state, scheduled_for);
CREATE INDEX idx_alerts_status_opened ON alerts(status, opened_at DESC);
CREATE INDEX idx_notification_deliveries_status_next ON notification_deliveries(status, next_attempt_at);
