DROP INDEX idx_notification_deliveries_status_next;

ALTER TABLE notification_deliveries RENAME TO notification_deliveries_v4;

CREATE TABLE notification_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  alert_id TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  channel_key TEXT NOT NULL CHECK (length(channel_key) BETWEEN 1 AND 64),
  notification_type TEXT NOT NULL CHECK (notification_type IN ('open', 'recovery')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL,
  claimed_at INTEGER,
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 1024),
  sent_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (alert_id, channel_key, notification_type),
  CHECK (
    (status = 'sending' AND claimed_at IS NOT NULL)
    OR (status <> 'sending' AND claimed_at IS NULL)
  )
);

INSERT INTO notification_deliveries (
  id, alert_id, channel_key, notification_type, status, attempts,
  next_attempt_at, claimed_at, last_error, sent_at, created_at, updated_at
)
SELECT id, alert_id, channel_key, 'open',
       CASE WHEN status = 'sending' THEN 'pending' ELSE status END,
       attempts, next_attempt_at, NULL,
       CASE WHEN status = 'sending'
         THEN COALESCE(last_error, 'delivery reset during outbox migration')
         ELSE last_error END,
       sent_at, created_at, updated_at
FROM notification_deliveries_v4;

DROP TABLE notification_deliveries_v4;

CREATE INDEX idx_notification_deliveries_status_next
  ON notification_deliveries(status, next_attempt_at, id);

CREATE INDEX idx_notification_deliveries_claimed
  ON notification_deliveries(status, claimed_at);

INSERT INTO notification_deliveries (
  id, alert_id, channel_key, notification_type, status, attempts,
  next_attempt_at, created_at, updated_at
)
SELECT lower(hex(randomblob(16))), id, 'discord', 'open', 'pending', 0,
       opened_at, opened_at, opened_at
FROM alerts
WHERE status = 'open'
ON CONFLICT(alert_id, channel_key, notification_type) DO NOTHING;
