ALTER TABLE repository_stats
  ADD COLUMN job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;

ALTER TABLE repository_stats
  ADD COLUMN is_anomalous INTEGER NOT NULL DEFAULT 0 CHECK (is_anomalous IN (0, 1));

ALTER TABLE alerts
  ADD COLUMN repository_id TEXT REFERENCES repositories(id) ON DELETE SET NULL;

ALTER TABLE alerts
  ADD COLUMN measurement_type TEXT CHECK (
    measurement_type IS NULL OR measurement_type IN (
      'restic_restore_size', 'restic_raw_data', 'restic_total_size', 'backend_physical_bytes'
    )
  );

ALTER TABLE alerts
  ADD COLUMN baseline_value_bytes INTEGER CHECK (
    baseline_value_bytes IS NULL OR baseline_value_bytes BETWEEN 0 AND 9007199254740991
  );

CREATE INDEX idx_repository_stats_job_dimension_measured
  ON repository_stats(job_id, repository_id, measurement_type, measured_at DESC, id DESC);

CREATE UNIQUE INDEX idx_alerts_open_repository_growth_dimension
  ON alerts(job_id, repository_id, measurement_type)
  WHERE rule_key = 'repository_growth'
    AND status = 'open'
    AND repository_id IS NOT NULL
    AND measurement_type IS NOT NULL;
