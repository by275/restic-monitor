import { queueOpenNotifications, queueRecoveryNotification } from "./notifications";

const RETENTION_DAYS = 400;
const RETENTION_BATCH_SIZE = 100;
const BASELINE_SAMPLE_COUNT = 7;
const MINIMUM_BASELINE_SAMPLES = 5;
const MINIMUM_ABSOLUTE_GROWTH_BYTES = 100 * 1024 * 1024;

export interface RepositoryStatsMeasurement {
  mode: "restore-size" | "raw-data";
  value_bytes: number;
  total_file_count?: number | null;
  total_blob_count?: number | null;
  snapshots_count?: number | null;
  total_uncompressed_size?: number | null;
}

interface PriorMeasurement {
  id: string;
  value_bytes: number;
  measured_at: number;
}

interface OpenGrowthAlert {
  id: string;
  dedupe_key: string;
  baseline_value_bytes: number;
}

export async function prepareRepositoryStatsStatements(
  db: D1Database,
  input: {
    jobId: string;
    hostId: string;
    repositoryId: string;
    repositoryKey: string;
    runId: string;
    measuredAt: number;
    receivedAt: number;
    measurement: RepositoryStatsMeasurement;
  },
): Promise<D1PreparedStatement[]> {
  const measurementType = input.measurement.mode === "restore-size"
    ? "restic_restore_size"
    : "restic_raw_data";
  const statId = `${input.runId}:${measurementType}`;
  const cutoff = input.receivedAt - RETENTION_DAYS * 86_400_000;

  const [latest, baselineRows, openAlert] = await Promise.all([
    db.prepare(
      `SELECT id, value_bytes, measured_at FROM repository_stats
       WHERE job_id = ? AND repository_id = ? AND measurement_type = ?
         AND measured_at >= ? AND id <> ?
       ORDER BY measured_at DESC, id DESC LIMIT 1`,
    )
      .bind(input.jobId, input.repositoryId, measurementType, cutoff, statId)
      .first<PriorMeasurement>(),
    db.prepare(
      `SELECT rs.id, rs.value_bytes, rs.measured_at
       FROM repository_stats AS rs
       INNER JOIN runs AS r ON r.id = rs.source_run_id
       WHERE rs.job_id = ? AND rs.repository_id = ? AND rs.measurement_type = ?
         AND rs.is_anomalous = 0 AND rs.measured_at >= ?
         AND (rs.measured_at < ? OR (rs.measured_at = ? AND rs.id < ?))
         AND r.operation = 'stats' AND r.status = 'success'
       ORDER BY rs.measured_at DESC, rs.id DESC LIMIT ?`,
    )
      .bind(
        input.jobId,
        input.repositoryId,
        measurementType,
        cutoff,
        input.measuredAt,
        input.measuredAt,
        statId,
        BASELINE_SAMPLE_COUNT,
      )
      .all<PriorMeasurement>(),
    db.prepare(
      `SELECT id, dedupe_key, baseline_value_bytes FROM alerts
       WHERE rule_key = 'repository_growth' AND status = 'open'
         AND job_id = ? AND repository_id = ? AND measurement_type = ?
       LIMIT 1`,
    )
      .bind(input.jobId, input.repositoryId, measurementType)
      .first<OpenGrowthAlert>(),
  ]);

  const isNewest = latest === null || compareMeasurementOrder(
    input.measuredAt,
    statId,
    latest.measured_at,
    latest.id,
  ) > 0;
  const baseline = openAlert === null
    ? baselineRows.results.length >= MINIMUM_BASELINE_SAMPLES
      ? median(baselineRows.results.map((row) => row.value_bytes))
      : null
    : openAlert.baseline_value_bytes;
  const anomalous = isNewest && baseline !== null && isGrowthAnomaly(
    input.measurement.value_bytes,
    baseline,
  );

  const details = Object.fromEntries(
    ([
      "total_file_count",
      "total_blob_count",
      "snapshots_count",
      "total_uncompressed_size",
    ] as const)
      .filter((key) => input.measurement[key] !== undefined)
      .map((key) => [key, input.measurement[key]]),
  );
  const statements = [
    db.prepare(
      `INSERT INTO repository_stats (
         id, repository_id, source_run_id, measurement_type, value_bytes,
         measured_at, details_json, created_at, job_id, is_anomalous
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      statId,
      input.repositoryId,
      input.runId,
      measurementType,
      input.measurement.value_bytes,
      input.measuredAt,
      JSON.stringify(details),
      input.receivedAt,
      input.jobId,
      anomalous ? 1 : 0,
    ),
  ];

  if (isNewest && openAlert === null && anomalous && baseline !== null) {
    const dedupeKey = `repository_growth:${input.jobId}:${input.repositoryId}:${measurementType}:${input.runId}`;
    const increase = input.measurement.value_bytes - baseline;
    statements.push(
      db.prepare(
        `INSERT OR IGNORE INTO alerts (
           id, dedupe_key, rule_key, severity, status, host_id, job_id, run_id,
           repository_id, measurement_type, baseline_value_bytes, message, opened_at, created_at
         ) VALUES (?, ?, 'repository_growth', 'warning', 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID().replaceAll("-", ""),
        dedupeKey,
        input.hostId,
        input.jobId,
        input.runId,
        input.repositoryId,
        measurementType,
        baseline,
        `Repository ${input.repositoryKey} ${input.measurement.mode} grew from ${baseline} to ${input.measurement.value_bytes} bytes (+${increase} bytes).`,
        input.receivedAt,
        input.receivedAt,
      ),
      queueOpenNotifications(db, input.jobId, input.receivedAt),
    );
  } else if (isNewest && openAlert !== null && !anomalous) {
    statements.push(
      db.prepare(
        `UPDATE alerts SET status = 'resolved', resolved_at = ?
         WHERE id = ? AND status = 'open'`,
      ).bind(input.receivedAt, openAlert.id),
      queueRecoveryNotification(db, openAlert.dedupe_key, input.receivedAt),
    );
  }

  statements.push(
    db.prepare(
      `DELETE FROM repository_stats
       WHERE id IN (
         SELECT id FROM repository_stats
         WHERE measured_at < ? ORDER BY measured_at ASC, id ASC LIMIT ?
       )`,
    ).bind(cutoff, RETENTION_BATCH_SIZE),
  );
  return statements;
}

export function isGrowthAnomaly(value: number, baseline: number): boolean {
  const increase = value - baseline;
  return increase >= MINIMUM_ABSOLUTE_GROWTH_BYTES && increase >= Math.ceil(baseline * 0.5);
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  const lower = sorted[middle - 1]!;
  const upper = sorted[middle]!;
  return lower + Math.floor((upper - lower) / 2);
}

function compareMeasurementOrder(
  leftAt: number,
  leftId: string,
  rightAt: number,
  rightId: string,
): number {
  if (leftAt !== rightAt) return leftAt - rightAt;
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
