CREATE TABLE job_schedule_state (
  job_id TEXT PRIMARY KEY NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  schedule TEXT NOT NULL CHECK (length(schedule) BETWEEN 1 AND 128),
  timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 64),
  evaluated_through INTEGER NOT NULL,
  last_checked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_job_schedule_state_fairness
  ON job_schedule_state(last_checked_at, job_id);

CREATE INDEX idx_schedule_occurrences_job_state_time
  ON schedule_occurrences(job_id, state, scheduled_for DESC);

CREATE UNIQUE INDEX idx_schedule_occurrences_matched_run
  ON schedule_occurrences(matched_run_id)
  WHERE matched_run_id IS NOT NULL;
