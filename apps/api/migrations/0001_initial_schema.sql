CREATE TABLE hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE CHECK (length(name) BETWEEN 1 AND 128),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 128),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE repositories (
  id TEXT PRIMARY KEY NOT NULL,
  repository_key TEXT NOT NULL UNIQUE CHECK (length(repository_key) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  backend_type TEXT NOT NULL CHECK (backend_type IN ('local', 'sftp', 'rest', 's3', 'b2', 'azure', 'gs', 'other')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK (length(slug) BETWEEN 1 AND 100),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  operation TEXT NOT NULL CHECK (operation IN ('backup', 'forget', 'prune', 'forget_prune', 'copy', 'stats', 'check', 'restore')),
  max_runtime_seconds INTEGER NOT NULL CHECK (max_runtime_seconds BETWEEN 1 AND 31536000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(host_id, slug)
);

CREATE TABLE job_tags (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tag TEXT NOT NULL CHECK (length(tag) BETWEEN 1 AND 64),
  PRIMARY KEY(job_id, tag)
);

CREATE TABLE job_repositories (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('repository', 'source', 'target')),
  PRIMARY KEY(job_id, repository_id, role)
);

CREATE TABLE notification_targets (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'telegram')),
  config_json TEXT NOT NULL CHECK (length(config_json) BETWEEN 2 AND 4096 AND json_valid(config_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE job_notification_targets (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES notification_targets(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(job_id, target_id)
);

CREATE TABLE job_ping_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  token_prefix TEXT NOT NULL CHECK (length(token_prefix) BETWEEN 1 AND 16),
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE UNIQUE INDEX idx_job_ping_tokens_one_active
  ON job_ping_tokens(job_id) WHERE revoked_at IS NULL;

CREATE TABLE job_schedule_rules (
  id TEXT PRIMARY KEY NOT NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  schedule_type TEXT NOT NULL CHECK (schedule_type IN ('cron', 'interval', 'oncalendar')),
  expression TEXT NOT NULL CHECK (length(expression) BETWEEN 1 AND 256),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  start_grace_seconds INTEGER NOT NULL DEFAULT 0 CHECK (start_grace_seconds BETWEEN 0 AND 31536000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(job_id, sort_order)
);

CREATE TABLE job_schedule_state (
  schedule_rule_id TEXT PRIMARY KEY NOT NULL REFERENCES job_schedule_rules(id) ON DELETE CASCADE,
  expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  evaluated_through INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  workflow_id TEXT CHECK (workflow_id IS NULL OR length(workflow_id) <= 64),
  operation TEXT NOT NULL CHECK (operation IN ('backup', 'forget', 'prune', 'forget_prune', 'copy', 'stats', 'check', 'restore')),
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'partial_success', 'failed', 'timed_out', 'cancelled')),
  exit_code INTEGER CHECK (exit_code IS NULL OR exit_code BETWEEN 0 AND 255),
  client_name TEXT NOT NULL DEFAULT 'unknown' CHECK (length(client_name) BETWEEN 1 AND 128),
  client_version TEXT NOT NULL DEFAULT 'unknown' CHECK (length(client_version) BETWEEN 1 AND 64),
  restic_version TEXT CHECK (restic_version IS NULL OR length(restic_version) <= 64),
  started_at INTEGER NOT NULL,
  start_ping_received INTEGER NOT NULL DEFAULT 1 CHECK (start_ping_received IN (0, 1)),
  finished_at INTEGER,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms BETWEEN 0 AND 9007199254740991),
  error_summary TEXT CHECK (error_summary IS NULL OR length(error_summary) <= 1024),
  completion_hash TEXT CHECK (completion_hash IS NULL OR (length(completion_hash) = 64 AND completion_hash NOT GLOB '*[^a-f0-9]*')),
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
  PRIMARY KEY(run_id, repository_id, role)
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

CREATE TABLE repository_stats (
  id TEXT PRIMARY KEY NOT NULL,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE RESTRICT,
  source_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE RESTRICT,
  measurement_type TEXT NOT NULL CHECK (measurement_type IN ('restic_restore_size', 'restic_raw_data', 'restic_total_size', 'backend_physical_bytes')),
  value_bytes INTEGER NOT NULL CHECK (value_bytes BETWEEN 0 AND 9007199254740991),
  measured_at INTEGER NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}' CHECK (length(details_json) <= 8192 AND json_valid(details_json)),
  is_anomalous INTEGER NOT NULL DEFAULT 0 CHECK (is_anomalous IN (0, 1)),
  created_at INTEGER NOT NULL
);

CREATE TABLE schedule_occurrences (
  schedule_rule_id TEXT NOT NULL REFERENCES job_schedule_rules(id) ON DELETE CASCADE,
  scheduled_for INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending', 'matched', 'missed')),
  matched_run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(schedule_rule_id, scheduled_for)
);
CREATE UNIQUE INDEX idx_schedule_occurrences_matched_run
  ON schedule_occurrences(matched_run_id) WHERE matched_run_id IS NOT NULL;

CREATE TABLE alerts (
  id TEXT PRIMARY KEY NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) BETWEEN 1 AND 256),
  rule_key TEXT NOT NULL CHECK (length(rule_key) BETWEEN 1 AND 64),
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'suppressed')),
  host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  run_id TEXT REFERENCES runs(id) ON DELETE SET NULL,
  schedule_rule_id TEXT,
  occurrence_scheduled_for INTEGER,
  repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL,
  measurement_type TEXT,
  baseline_value_bytes INTEGER,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1024),
  opened_at INTEGER NOT NULL,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (schedule_rule_id, occurrence_scheduled_for)
    REFERENCES schedule_occurrences(schedule_rule_id, scheduled_for) ON DELETE SET NULL,
  CHECK ((schedule_rule_id IS NULL) = (occurrence_scheduled_for IS NULL))
);

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL CHECK (length(target_id) = 36),
  provider TEXT NOT NULL CHECK (provider IN ('discord', 'telegram')),
  target_name TEXT NOT NULL CHECK (length(target_name) BETWEEN 1 AND 128),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('open', 'recovery')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(alert_id, target_id, notification_type)
);

CREATE INDEX idx_jobs_enabled ON jobs(enabled, host_id);
CREATE INDEX idx_jobs_slug ON jobs(host_id, slug);
CREATE INDEX idx_job_schedules_enabled ON job_schedule_rules(enabled, job_id, sort_order);
CREATE INDEX idx_runs_job_started ON runs(job_id, started_at DESC);
CREATE INDEX idx_runs_status_started ON runs(status, started_at DESC);
CREATE INDEX idx_run_repositories_repository_run ON run_repositories(repository_id, run_id);
CREATE INDEX idx_repository_stats_repository_measured ON repository_stats(repository_id, measured_at DESC);
CREATE INDEX idx_repository_stats_job_dimension_measured
  ON repository_stats(job_id, repository_id, measurement_type, measured_at DESC, id DESC);
CREATE INDEX idx_schedule_occurrences_state_time
  ON schedule_occurrences(state, scheduled_for);
CREATE INDEX idx_alerts_status_opened ON alerts(status, opened_at DESC);
CREATE INDEX idx_notification_deliveries_status_next
  ON notification_deliveries(status, next_attempt_at, id);
CREATE INDEX idx_notification_deliveries_claimed
  ON notification_deliveries(status, claimed_at);
CREATE INDEX idx_job_notification_targets_target
  ON job_notification_targets(target_id, job_id);
