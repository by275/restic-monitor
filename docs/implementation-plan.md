# Restic Monitor 구현 계획 및 기술 검토

- 상태: 1~7단계 구현 완료 및 로컬 검증됨. 8단계용 opt-in Docker shim, Compose 예제와 가짜 Restic 기반 검증을 저장소 안에 준비했다. 실제 Host 적용과 Repository 실행은 대상 설정과 안전한 검증 범위가 필요하다.
- 기준일: 2026-10-11
- 설계 입력: [Restic Monitor 설계 대화](https://chatgpt.com/share/6acafa87-5670-83ee-8073-35f9da97447e)
- 저장소 상태: 계획 작성 당시 작업 디렉터리에 기존 코드나 백업 환경 파일이 없었다. 실제 Docker/cron 스크립트는 구현 전 통합 단계에서 확인해야 한다.

## 요약

설계의 Push 수집, 기존 Docker + cron 유지, Bash Reporter에서 Go로의 교체, Workers + D1 사용은 개인용 소규모 백업 모니터의 출발점으로 타당하다. 다만 v0.1에는 실행 이벤트와 D1 외래 키의 식별자 불일치, 이벤트 재전송 경합, 여러 명령 결과를 담을 지표 모델의 부족, cron 감시의 시간대와 복구 의미, 알림 전달 보장 문제가 남아 있다.

권장 구현 순서는 다음과 같다.

**프로토콜과 로컬 기반 → 인증된 수집 API 및 D1 원자 처리 → Bash Reporter → 읽기 전용 대시보드 → 스케줄 감지 → 영속 알림 outbox → 저장소 통계와 이상 탐지 → 운영 호스트 적용.**

계획 검토 때는 애플리케이션 구현과 백업 환경 변경을 보류했다. 현재는 승인된 단계별 범위에 따라 구현한다.

## 설계서 검토

| 영역 | 판단 | 수정 또는 확정할 내용 |
|---|---|---|
| Push 방식과 기존 cron 유지 | 적절 | Reporter를 선택적 Wrapper로 붙이고 기존 cron을 계속 실행한다. |
| Worker + D1 | MVP에 적절 | 사용량이 작은 개인 환경에 맞는다. D1의 Free 한도 초과는 일일 리셋까지 쓰기와 읽기가 실패할 수 있으므로 사용량 감시와 보존 정책이 필요하다. |
| Hono와 단일 Worker 정적 자산 | 가능 | API, UI, 배포 자동화는 단계별로 붙인다. 첫 MVP에서 관리자 설정 CRUD 전체를 만들지 않는다. |
| 관리자 인증 | 보완 필요 | Cloudflare Access 정책을 Worker의 모든 접근 가능한 호스트명/URL에 적용한다. 앱에서 Access 토큰을 직접 확인하는 경우 헤더 존재만 믿지 말고 서명, issuer, audience, 만료를 검증한다. |
| Restic JSON 처리 | 명령별 파서 필요 | `backup`은 JSON Lines, `stats`는 단일 JSON, `forget`은 단일 배열이다. 현재 안정판에서 `prune`은 JSON을 지원하지 않으며 `forget --prune` 출력은 JSON과 텍스트가 섞일 수 있다. 종료 코드와 stderr를 함께 판정한다. |
| 성공/실패 모델 | 보완 필요 | exit code 3을 모든 작업에서 똑같이 처리하지 않는다. Restic 문서상 backup의 일부 파일 읽기 실패 또는 forget에서 일부 snapshot 미삭제를 나타낸다. 알 수 없는 비영(非零) 코드는 실패로 본다. |
| API 이벤트 모델 | 보완 필요 | Host는 Host 범위 토큰으로 식별하고 본문에서 신뢰하지 않는다. Job/Repository 참조는 토큰 권한과 서버 등록 정보로 검증한다. 완료 이벤트만 먼저 도착해도 실행을 복원하고, 뒤늦은 시작 이벤트가 완료 상태를 되돌리지 않아야 한다. |
| D1 모델 | 보완 필요 | `ingest_events`의 중복 범위, run 키 유일성, token 참조, 이벤트/실행 갱신 원자성, 작업별 지표, 예정 실행별 late 알림 키를 명확히 한다. |
| 재전송 및 부분 실패 | 단순화 권장 | MVP는 이벤트 하나당 요청 하나로 시작한다. 같은 이벤트를 같은 ID로 재전송한다. 배치 endpoint는 부분 승인 규약과 재시도 의미가 정해질 때까지 미룬다. |
| 알림 전송 | 보완 필요 | `ctx.waitUntil()`이나 HTTP 요청 안의 단발 전송은 전달 보장이 아니다. D1 outbox에 보류/시도 횟수/다음 재시각/성공을 기록한다. |
| 누락된 cron 감지 | 보완 필요 | Job의 IANA timezone, 발생 시각, grace, 실행 매칭 규칙, 지연 시작 처리, 경보 중복 억제를 명시한다. Worker Cron은 UTC로 실행되므로 별도의 Job 일정을 평가해야 한다. |
| 데이터 보안과 보존 | 보완 필요 | 원시 Restic 출력과 경로를 서버에 저장하지 않는다. 오류 요약 길이를 제한하고 민감 정보를 제거한다. 이벤트·실행·알림 보존 기간을 정한다. |

### Restic 출력에서 반영한 동작

- `restic backup --json` stdout은 JSON Lines다. 마지막 성공 `summary`에는 `data_added`, `data_added_packed`, `total_bytes_processed`, 파일 개수와 `snapshot_id` 등이 있다. `snapshot_id`는 snapshot 생성을 건너뛰면 없을 수 있다.
- Restic의 fatal `exit_error`는 stderr에 JSON으로 출력될 수 있지만, 일부 런타임/인자 오류는 이 형식이 아닐 수 있다. 모든 오류를 JSON으로 가정하지 않는다.
- 안정판 Restic 0.19.1 문서에서 `forget`은 JSON 배열을 반환하며, 지정한 snapshot ID를 직접 대상으로 하면 출력이 없을 수 있다. `prune`은 아직 JSON을 지원하지 않아 `forget --prune`은 JSON과 텍스트가 섞인다. 따라서 `prune`의 세부 통계는 MVP에서 선택 항목으로 두고, 실행 상태의 기준은 종료 코드와 제한된 오류 요약으로 삼는다.
- `restic stats --json` 결과는 선택한 mode와 snapshot 범위에 대한 Restic 통계다. 이를 백엔드 파일시스템의 물리 사용량과 동일한 값으로 표시하지 않는다.
- Fixture와 지원 버전은 안정판 기준으로 먼저 고정한다. 개발 브랜치 문서와 향후 Restic 릴리스에서 출력 형식이 추가/변경될 수 있으므로 새 버전을 지원할 때 fixture와 파서를 갱신한다.

### Cloudflare Free 적합성

2026-10-11 현재 공식 한도 문서 기준으로 Workers Free는 하루 100,000 요청, HTTP/Cron invocation당 CPU 10ms, invocation당 일반 subrequest 50회, 계정당 Cron Trigger 5개다. D1 Free는 DB당 500MB, 계정 전체 저장공간 5GB, 하루 5백만 rows read와 100,000 rows written이며, 한도 초과 시 D1 쿼리가 실패할 수 있다. D1 문자열/BLOB/단일 행 크기 제한은 2MB다. 사용량이 작은 수 대 호스트라면 시작하기에 충분하지만, 원시 Restic 출력 저장, 무제한 이력, 비효율적 전체 테이블 조회는 피해야 한다. API 본문은 애플리케이션에서 예를 들어 64KiB로 제한하고, Free CPU 예산에 맞춰 Worker에서 Restic 원본 로그를 파싱하지 않는다.

Worker Cron은 UTC 기준이다. `*/5 * * * *` 한 개의 Trigger가 여러 Job을 검사하도록 구성하고, 각 Job의 시간대 변환은 애플리케이션에서 수행한다. Free 계정은 Cron Trigger가 5개까지이고 Worker/D1 CPU 및 쿼리 한도도 있으므로, Worker는 인덱스를 사용해 제한된 수의 행만 처리한다. Worker 자체가 실행되지 않는 장애까지 같은 Worker가 스스로 감지할 수 없으므로 안정화 전후 모두 외부 heartbeat 감시를 유지한다.

## 제안하는 이벤트 프로토콜 v1

### 규약

1. 모든 요청은 `POST /api/v1/ingest/events`로 이벤트 하나를 보낸다. MVP에는 별도 `/batch` endpoint가 없다.
2. `schema_version`은 필수 정수다. `event_id`와 `run_id`는 클라이언트가 한 번 생성해 spool 재시도 동안 그대로 사용한다. UUIDv7 또는 ULID를 권장한다.
3. `Authorization: Bearer …`의 토큰은 Host에 귀속한다. Host 이름은 payload에서 신뢰하지 않는다. `job_key`와 `repository_key`는 해당 토큰으로 허용된 Host/Job/Repository 연결에 속하는지 서버가 확인한다.
4. 본문 시간은 RFC3339 UTC다. 서버는 별도로 `received_at`을 기록하고, 실행 시간·duration·시계 오차를 검증한다.
5. `run.started`는 진행 중 표시용이다. `run.completed`에는 시작과 종료 시각을 모두 넣어 시작 이벤트 유실이나 도착 순서 역전을 복구한다.
6. 클라이언트는 `status`를 보내지 않는다. 서버가 `operation`, 종료 코드, 스케줄러의 timeout 관찰을 바탕으로 상태를 계산한다. 알 수 없는 종료 코드는 실패로 처리한다.
7. `metrics`는 operation별 허용 필드로 검증한다. 알려진 공통 지표만 전용 컬럼에 저장하고 향후 확장 필드는 수집기에서 무시한다. Restic 원본 stdout/stderr 전체는 전송하지 않는다.
8. 동일 `(token_id, event_id)`와 동일 payload hash는 중복 승인 응답을 돌려준다. 같은 ID에 다른 hash가 오면 `409 Conflict`다. 이벤트 기록과 run projection 갱신은 하나의 이벤트 단위로 원자 처리한다.
9. 완료 상태는 늦게 도착한 `run.started`로 되돌아가지 않는다. 같은 run에 상충하는 두 개의 완료 결과가 오면 두 번째는 충돌로 응답한다.

v1의 숫자 지표는 JavaScript와 SQLite 경계에서 정확성을 보장하도록 0부터 `9007199254740991`까지로 제한한다. Restic의 uint64 출력이 이 범위를 넘으면 Reporter가 반올림해 보내지 말고 해당 지표를 알 수 없는 값으로 남긴다.

### 예시

```json
{
  "schema_version": 1,
  "event_id": "019a9f34-8ac0-7a00-a001-123456789abc",
  "run_id": "019a9f34-8ac0-7a00-a002-123456789abc",
  "workflow_id": "019a9f34-8ac0-7a00-a003-123456789abc",
  "event_type": "run.started",
  "occurred_at": "2026-10-11T05:00:00Z",
  "job_key": "docker-daily",
  "repository_key": "repo-a",
  "operation": "backup",
  "client": {
    "name": "restic-monitor-bash",
    "version": "0.1.0",
    "restic_version": "0.19.1"
  }
}
```

```json
{
  "schema_version": 1,
  "event_id": "019a9f34-8ac0-7a00-a004-123456789abc",
  "run_id": "019a9f34-8ac0-7a00-a002-123456789abc",
  "workflow_id": "019a9f34-8ac0-7a00-a003-123456789abc",
  "event_type": "run.completed",
  "occurred_at": "2026-10-11T05:08:22Z",
  "job_key": "docker-daily",
  "repository_key": "repo-a",
  "operation": "backup",
  "client": {
    "name": "restic-monitor-bash",
    "version": "0.1.0",
    "restic_version": "0.19.1"
  },
  "result": {
    "exit_code": 3,
    "started_at": "2026-10-11T05:00:00Z",
    "finished_at": "2026-10-11T05:08:22Z",
    "duration_ms": 502000,
    "error_summary": "Some source files could not be read",
    "metrics": {
      "bytes_processed": 536870912000,
      "bytes_added": 251658240,
      "bytes_added_packed": 184549376,
      "files_new": 12,
      "files_changed": 38,
      "snapshot_id": "abcdef123456"
    }
  }
}
```

`bytes_added`는 Restic `data_added`(압축 전), `bytes_added_packed`는 `data_added_packed`(압축 후), `bytes_processed`는 `total_bytes_processed`로 매핑한다. 필드가 없거나 snapshot이 생성되지 않은 경우 `null`/미포함으로 보존하고 0으로 추정하지 않는다.

Repository stats는 `run.completed.result.repository_stats`에 `mode`와 `value_bytes`를 담는다. v1은 `restore-size`와 `raw-data`만 지원하며 Restic의 mode 종속 `total_size`를 이름만으로 해석하지 않는다. API는 이를 `restic_restore_size`/`restic_raw_data` 시계열로 변환한다. backup 증분 지표와 별도 필드·테이블에 두며 backend 저장공간 사용량은 이 데이터로 추정하지 않는다.

### 응답과 재시도

- `200`: 저장 완료 또는 같은 payload의 중복 수락. 응답에 `event_id`, `accepted`, `duplicate`, `received_at`을 포함한다.
- `400/413/415/422`: 잘못된 JSON, 제한 크기 초과, 지원하지 않는 Content-Type, 계약 위반. 자동 재시도하지 않고 로컬 격리/운영자 확인 대상으로 둔다.
- `401/403`: 토큰 또는 권한 문제. 운영자 설정 확인 전까지 재시도 폭주를 막고 이벤트를 보존한다.
- `409`: event ID 재사용 또는 완료 결과 충돌. 자동 덮어쓰기하지 않고 격리한다.
- `429`: `Retry-After`를 따르고 재시도한다.
- 네트워크 오류와 `5xx`: 같은 event ID와 본문으로 지수형 backoff + jitter 재시도한다.
- Bash는 이벤트를 spool에 원자적으로 기록한 후 전송한다. 명시적인 2xx 수락/중복 응답 뒤에만 제거한다. 횟수/용량 제한, 잠금, 파일 권한과 격리 큐를 둔다.
- 서버의 event dedupe 기록은 클라이언트가 spool을 보존할 수 있는 최대 기간보다 오래 유지한다. 큐가 그 기간을 넘긴 이벤트는 자동 재생하지 않고 격리해 중복 반영을 막는다.
- Reporter는 전송 실패를 로그로 알리되 원래 Restic의 종료 코드를 반환한다. 이 정책은 모니터링 전송 장애가 백업 결과에 영향을 주지 않게 한다.

## D1 모델 제안

실행은 현재 상태 조회를 위한 projection이고, `ingest_events`는 중복 방지와 감사용 불변 원장이다. 이벤트 원장에 payload 전체를 무기한 쌓지 않는다.

| 테이블 | 책임과 주요 제약 |
|---|---|
| `hosts` | Host 설정, `name` 유일성, 활성 여부 |
| `repositories` | 논리 Repository 설정과 backend 종류. Restic URL/비밀번호는 저장하지 않음 |
| `jobs` | Host별 작업, `UNIQUE(host_id, name)`, cron 표현식, IANA timezone, grace/timeout, 활성 여부 |
| `job_repositories` | Job과 Repository 허용 연결, 역할, 복합 PK |
| `api_tokens` | token public id/prefix, Host FK, SHA-256 digest, scope, 만료/폐기/마지막 사용 시각. 원문 토큰 미저장 |
| `runs` | run id, job FK, workflow id, operation, 상태 CHECK, exit code, 시작/종료/duration, 클라이언트·Restic 버전, 제한된 오류 요약. Repository 연결은 별도 테이블에 두며 Terminal 상태는 오래된 시작 이벤트가 덮지 못하게 함 |
| `run_repositories` | 실행과 Repository의 연결. 일반 작업은 `repository` 역할 하나를, copy는 `source`와 `target` 역할을 저장하며 `(run_id, repository_id, role)`을 유일하게 둠 |
| `run_metrics` | run당 operation별 공통 지표와 `metrics_json`. 크기 제한과 operation별 스키마 검증 |
| `ingest_events` | `PRIMARY KEY(token_id, event_id)`, run/event type, payload hash, server receive time. 이벤트 유효 기간 및 보존 정책 |
| `repository_stats` | Repository 시계열. `measurement_type`, nullable `job_id`, `is_anomalous`, source run과 정확한 byte 값을 저장해 Job/mode별 baseline을 구별 |
| `schedule_occurrences` | `(job_id, scheduled_for)` 유일한 예정 실행 슬롯과 상태, 매칭 run/late 경보. Worker Cron 지연 실행 뒤에도 누락 슬롯을 재구성 |
| `alerts` | 고유 `dedupe_key`, rule/severity/status, 열린/해결 시각, 연결 Job/run/occurrence |
| `notification_deliveries` | alert와 채널별 outbox, attempts, `next_attempt_at`, last error, sent time, 재시도 상태 |

시간 비교와 정렬에 쓰는 모든 D1 시각(`occurred_at` 원본 외)은 Unix epoch milliseconds 정수로 저장한다. API는 RFC3339 UTC를 받는다. SQLite `CURRENT_TIMESTAMP`의 문자열 형식과 혼용하지 않도록 Worker가 `Date.now()`를 명시적으로 전달한다.

`runs`에는 단일 `repository_id`를 두지 않는다. 실행 하나가 source와 target 두 저장소를 참조할 수 있기 때문이다. Repository별 실행 이력 인덱스는 `run_repositories(repository_id, run_id)`와 `runs(job_id, started_at DESC)`, `runs(status, started_at)` 조합으로 조회한다. 나머지 필수 인덱스는 `repository_stats(repository_id, measured_at DESC)`, `schedule_occurrences(state, scheduled_for)`, `alerts(status, opened_at DESC)`, `notification_deliveries(status, next_attempt_at)`다. 이벤트 처리의 D1 batch는 개별 이벤트의 원자 경계로 사용한다. D1 batch 실패 시 해당 batch 전체가 롤백될 수 있으므로 여러 클라이언트 이벤트를 한 transaction으로 묶어 일부 이벤트까지 실패시키지 않는다.

### 2단계 수집 경계 확정

- 요청은 `application/json`만 받고 UTF-8 본문은 65,536 bytes까지 허용한다. `Content-Length`와 실제 스트림 길이를 모두 확인한다. JSON Schema draft 2020-12를 검증한 뒤 시각 순서, duration, 허용된 Job/Repository 관계를 추가 검증한다.
- Reporter 토큰은 `rm1_` + 32 random bytes의 base64url 인코딩이다. D1에는 SHA-256 digest만 넣고 원문은 발급 시 한 번만 보여준다. 토큰은 Host와 `ingest` scope에 묶이며 인증 실패 응답은 세부 사유를 노출하지 않는다.
- payload hash는 수신한 정확한 UTF-8 본문 bytes의 SHA-256이다. `(token_id, event_id)` 충돌은 기존 hash를 조회해 동일 내용이면 최초 `received_at`으로 중복 승인하고, 다른 내용이면 409를 반환한다. 이벤트 원장, run projection, repository 연결, metrics와 token 사용 시각을 단일 D1 batch로 갱신한다.
- 완료 이벤트만 도착한 경우 완료 결과의 `started_at`으로 run을 복원한다. 완료 fingerprint와 run identity를 마이그레이션 trigger로 보호하고 Repository 연결에는 run당 역할별 유일성 제약을 둬서, 동시 요청의 서로 다른 완료 결과나 저장소 연결이 batch 전체를 rollback하게 한다.
- 종료 상태는 Restic 종료 코드와 operation으로 계산한다. 0은 success, backup/forget/forget_prune의 3은 partial_success, 130은 cancelled, 나머지 비영 코드는 failed다. `prune`의 코드 3은 partial success로 가정하지 않는다.
- 시각은 UTC RFC3339로 받고 시작/종료 역전, duration 불일치(1초 허용), 이벤트 발생 시각과 해당 실행 경계의 불일치(1초 허용), 5분 넘는 미래 시각을 거부한다. 과거 이벤트는 spool 재전송을 위해 허용한다.
- 오류 요약은 ANSI 제어 코드, URL, 명백한 POSIX/Windows 절대 경로 및 일반적인 secret assignment를 제거한 뒤 1,024자로 제한한다. 이 처리는 전체 로그 전송을 허용하지 않으며, Reporter도 원본 stdout/stderr를 보내지 않는다.
- 이번 단계에서는 Worker 내부 rate limit을 구현하지 않는다. 공개 배포 전에 Cloudflare edge rate limit과 계정 사용량 경보를 운영 설정으로 적용한다. Free 한도를 넘으면 D1 요청 자체가 실패할 수 있으므로 본문 크기 제한만으로 가용성을 보장하지 않는다.

MVP Discord는 Webhook URL 하나를 Worker Secret에 저장하고 알림 설정 전체 CRUD는 뒤로 미룬다. 추후 여러 채널을 지원할 때 비밀 저장 방식과 채널 테이블을 별도로 설계한다.

## 스케줄과 상태 의미

- Job schedule은 기존 Host의 실행 스케줄을 설명하는 메타데이터다. Worker Cron은 백업을 실행하지 않고 5분 간격으로 누락/timeout/outbox 상태만 검사한다.
- Job schedule은 표준 5-field cron 및 IANA timezone으로 제한한다. 초 단위 cron과 임의 cron 확장 문법은 MVP에서 제외한다. DST gap/fold 시각 처리 규칙을 문서화하고 테스트한다.
- 예정 실행 슬롯마다 `schedule_occurrences`의 유일 키와 `alerts.dedupe_key`를 사용해 한 번만 late를 열고, 매칭 실행이 늦게 도착하면 해당 경보를 해결한다. Worker Cron 지연 후 과거 슬롯을 빠뜨리지 않고 catch up한다.
- grace 이후에도 시작 이벤트가 없으면 missed/late, 시작 후 timeout 초과 시 timed out alert를 연다. 종료 이벤트가 늦게 도착하면 실제 종료 결과를 기록하고 관련 경보를 resolve한다.
- 모니터링 시스템의 자체 장애는 외부 heartbeat로 감지한다. 자체 Worker만으로 자체 Cron 누락을 보증할 수 있다고 간주하지 않는다.
- Host/Job/Repository와 스케줄 설정 초기화는 첫 구현에서 마이그레이션 seed 또는 제한된 CLI/SQL 절차로 한다. UI에서 모든 설정을 편집하는 기능은 MVP 후순위다.

## 구현 단계와 완료 조건

각 단계는 독립적으로 테스트하고, 완료 결과를 확인한 뒤 다음 단계로 진행한다.

### 1단계 — 저장소 기반, 프로토콜, D1 첫 마이그레이션

**작업:** TypeScript/Workers/Hono 및 테스트 기반, 로컬 Wrangler + D1, JSON Schema/OpenAPI 계약과 예제 fixture, D1 초기 마이그레이션, health endpoint 및 로컬 실행 문서를 만든다. 여기서는 실제 백업 cron을 수정하지 않는다.

**검증:** 프로토콜 fixture의 정상/오류 스키마 테스트, 로컬 D1 migration 적용, FK/CHECK/유일성 제약 테스트, Wrangler 로컬 Worker smoke test.

**완료:** 신규 checkout에서 문서대로 로컬 Worker와 D1을 띄우고 프로토콜 fixture와 migration 테스트를 재현할 수 있다.

### 2단계 — 인증 및 이벤트 수집

**작업:** Host 범위 Bearer 토큰 검증, 단일 이벤트 endpoint, payload 크기/필드 및 시각 검증, event dedupe/hash conflict, 종료 선도착 복구, 실행 상태 projection, exit code 상태 매핑을 구현한다. 토큰 해시만 저장하는 로컬 발급 절차도 제공한다.

**검증:** 정상/부분/실패 종료, 잘못된 토큰, 범위 밖 Job/Repository, 동일 이벤트 재전송, 동일 ID 상이 본문 409, 완료 후 늦은 시작, 동일 run 상충 완료, 원자 rollback 테스트.

**완료:** 동일한 실제 fixture를 반복 전송해도 run과 metrics가 한 번만 반영되고 응답이 계약과 일치한다.

### 3단계 — Bash Reporter와 spool/retry

**작업:** `run`, `report`, `flush` CLI 또는 동등한 최소 Bash 인터페이스, Restic 프로세스 상태 보존, 명령별 JSON 파서, 원자 spool, 인증 헤더, 타임아웃/backoff/jitter/격리 정책을 구현한다.

**인터페이스:** `bin/restic-monitor run`은 명시한 Job/Repository/operation과 `--` 뒤의 Restic 인자를 그대로 사용한다. 실행 시작 이벤트를 먼저 큐에 넣고 전송을 비동기로 시도한 뒤 Restic을 실행한다. 종료 후 completion을 큐에 넣고 한 번 더 보낸다. 출력은 임시 파일에 분리 캡처한 뒤 종료 시 원래 stdout/stderr로 재생하므로 내용과 종료 코드는 보존되지만, 실행 중 진행 출력은 실시간으로 보이지 않는다. `report EVENT.json`은 이미 만들어진 계약 이벤트를 큐에 넣고, `flush`는 재시도를 수행한다.

Spool은 `pending/`, `quarantine/`, private `tmp/` 아래에 둔다. 각 이벤트 JSON은 atomic link/rename 방식으로 게시하고, 재시도 횟수와 다음 시각은 별도 state 파일에 둔다. 동일 ID·동일 바이트는 한 번만 큐에 있고 다른 바이트는 격리한다. 30일 초과 항목, 손상 파일, 영구 HTTP 오류, 큐 용량 제한으로 거부된 이벤트는 격리해 원문을 보존하며 자동 전송하지 않으므로 운영자가 원인을 해결한 뒤 수동 복구한다. 네트워크 오류, 408/429/5xx와 401/403은 같은 이벤트를 backoff 후 재시도하며, 인증을 복구하면 큐가 다시 전달된다. Spool 설정·권한 오류가 백업 명령을 막지는 않지만 이벤트 전달을 잃을 수 있으므로 `reporter.log`와 quarantine을 감시한다. Restic의 출력과 종료 상태는 Reporter 동작 실패에 영향받지 않는다.

`backup --json`에서 마지막 summary만 추출한다. 안전 정수 범위 밖의 uint64는 생략한다. `forget --json`과 `stats --json`은 구조만 검사하며 현재 프로토콜에 해당 지표가 없어 값을 보내지 않는다. `prune`은 JSON이 아니고 `forget --prune`은 혼합 출력이어서 파싱하지 않는다. 설치 Restic에 의존하지 않는 fixture는 공식 0.19.1 문서 형식으로 만든 계약 fixture이며, 실제 환경에서 캡처한 출력은 8단계 파일럿 때 별도 확인한다.

**검증:** 설치 Restic에 의존하지 않는 가짜 실행 파일과 버전별 fixture를 사용해 backup/forget/prune/forget-prune/stats를 검사한다. exit 0/3/1/10/11/12/130, summary 없음, 잘못된 JSON, SIGTERM, API network/429/5xx/4xx, spool 손상/중복 flush를 검증한다.

**완료:** 정상/부분/실패의 실제 Restic 종료 코드가 보존되고, 모니터링 장애는 이벤트를 spool에 남기며 백업 프로세스 결과를 바꾸지 않는다.

### 4단계 — 읽기 API와 최소 대시보드

**작업:** cursor pagination과 필터를 지원하는 `/overview`, `/runs`, `/runs/:runId`, `/hosts`, `/repositories`, `/repositories/:key/stats` 읽기 API, 실행 상세와 백업 증가량 및 Repository 측정 차트, Cloudflare Access 배포 안내를 구현한다. 목록 cursor는 정렬 키와 고유 ID를 사용하고 현재 필터 signature에 묶는다. Worker 조회는 prepared statement와 bind 값만 사용하며 pagination 정렬에 맞춘 D1 인덱스를 추가한다. 읽기 API는 `ADMIN_HOST`의 정확한 hostname만 허용해 `workers.dev` 또는 공개 ingest hostname을 통한 우회를 막는다. 실제 사용자 인증은 Cloudflare Access edge policy로 적용한다. 운영에서는 dashboard와 ingest를 별도 hostname으로 분리하고, dashboard hostname 전체에 Allow policy를 적용한다. ingest hostname은 Bearer 토큰으로만 수집 endpoint를 보호한다. `workers.dev`를 계속 켜 둘 경우에도 읽기 API host guard가 유지되어야 한다. UI는 Workers Static Assets로 제공하고 추가 프레임워크나 chart dependency를 두지 않는다. 관리 설정 CRUD와 UI 프레임워크 부가 기능은 범위를 제한한다.

**검증:** 조회 API의 host guard, 필터/커서 경계, 빈 데이터/오류 화면, run detail와 repository stats, Wrangler static asset smoke test를 검증한다. 로컬 테스트는 Cloudflare Access 로그인 흐름 자체를 대신하지 않으며, 실제 Access policy는 배포 hostname에 대해 Cloudflare 대시보드에서 별도로 구성한다.

**완료:** Host/Job/Repository별 최근 상태와 실행 상세를 확인하고 오래된 이력에 대해 제한된 페이지 조회를 할 수 있다. Dashboard hostname은 Access로 보호되며 public ingest hostname에서는 읽기 API가 거부된다.

### 5단계 — missed schedule / timeout 엔진

**작업:** Worker `scheduled()` handler와 `*/5 * * * *` trigger를 추가했다. `job_schedule_state`는 Job별 schedule/timezone snapshot, catch-up cursor, 마지막 검사 시각을 저장한다. 검사 기준은 실제 Worker invocation의 `Date.now()`다. Cloudflare `controller.scheduledTime`은 예약 시각이므로 사용하지 않는다. 새 Worker를 처음 켜거나 schedule/timezone이 바뀐 경우 그 시각을 기준점으로 삼아 오래된 슬롯을 소급 생성하지 않는다. 정상 운영 중 Cron 지연은 cursor 이후부터 한 번에 최대 20개 슬롯씩 따라잡으며, 최대 20개 Job을 마지막 검사 시각 순으로 처리해 작업 수가 늘어도 다음 invocation에서 순환한다.

발생 슬롯 생성, 실행 매칭, 경보와 run 상태 갱신, cursor 전진은 Job별 D1 `batch()` 하나로 커밋한다. 매칭은 최신 미매칭 슬롯부터 시작 시각이 해당 슬롯 이후인 가장 이른 미사용 run을 연결한다. 한 run은 partial unique index로 한 슬롯에만 연결된다. ingest 요청에서 occurrence를 바로 찾지는 않으므로 run 시작/완료 이벤트와 누락 경보의 매칭·해결은 다음 scheduler 처리 때 반영된다. 정상 부하에서는 최대 5분 지연이며 Job/slot catch-up backlog가 있으면 더 늦을 수 있다. grace가 지난 pending 슬롯에는 `missed_schedule:<job>:<timestamp>` dedupe key 경보를 한 번 연다. 일치 run이 뒤늦게 관측되면 슬롯을 `matched`로 바꾸고 해당 누락 경보를 해결한다. 늦은 실행이 여러 missed slot을 건너뛴 경우 가장 최신의 해당 슬롯 하나만 매칭되며, 앞선 missed 슬롯은 과거 누락으로 남는다.

실행이 timeout 경계를 넘으면 `run_timeout:<run>` 경보를 한 번 열고 run을 `timed_out`으로 표시한다. 이때 `finished_at`과 `duration_ms`는 관측된 timeout deadline을 나타내며, 종료 이벤트가 오면 실제 종료 시각/결과로 덮어쓰고 경보를 해결한다. schedule parse 오류가 있어도 해당 Job의 timeout 검사와 다른 Job 처리는 계속한다. Worker 자체의 Cron 누락은 외부 heartbeat로 감지한다.

5-field cron, IANA timezone 계산에는 Cloudflare Worker 런타임 호환성을 확인한 Croner 10.0.1을 사용한다. 분 단위 이상의 표준 cron 필드만 허용하며 초/year 확장과 Quartz 토큰은 받지 않는다. DST regression test는 New York의 봄 gap에서 `02:30` 슬롯이 로컬 `03:30`으로 이동하고, 가을 fold에서는 첫 `01:30`만 생성되는 동작을 고정했다. (라이브러리 README의 gap 설명과 직접 실행한 `nextRuns()` 결과가 일치하지 않아, 실제 설치 버전의 테스트 결과를 계약으로 기록했다.)

**검증:** Worker 테스트에서 실제 `scheduled()` export를 호출해 grace 경계, 늦은 run 매칭/복구, 60개 연속 슬롯 catch-up, 중복 Cron 재호출, DST spring/fall 전환, 잘못된 schedule 중 timeout 검사, timeout deadline과 늦은 완료 이벤트를 확인한다.

**완료:** 같은 누락 슬롯에 경보가 중복 생성되지 않고, 늦은 이벤트와 스케줄러 재호출 뒤에도 발생 슬롯·실행·경보가 일관된 최종 상태에 수렴한다.

### 6단계 — 영속 알림 outbox와 Discord

**작업:** alert별 Discord delivery, 제한된 retry, `Retry-After`, 성공/실패 추적, 복구 알림과 중복 억제를 구현했다. Webhook URL은 Cloudflare Secret binding `DISCORD_WEBHOOK_URL`에서만 읽으며 `wrangler.jsonc`에는 넣지 않는다. Worker는 D1 outbox에서 한 Cron invocation당 최대 10개 항목을 조건부 claim하고, claim lease가 만료된 항목은 다음 invocation에서 회수한다. 각 delivery는 `open`/`recovery` 유형별로 유일하고 `pending`/`sending`/`sent`/`dead`, 시도 횟수, 재시도 시각, 마지막 오류와 claim 시각을 보존한다. alert 생성 및 복구 delivery 추가는 alert 상태 변경과 같은 D1 batch에 들어간다. 기존 open alert는 migration에서 outbox에 보충하며 이미 resolve된 과거 alert에 대한 소급 복구 메시지는 만들지 않는다.

429는 Discord `Retry-After` header 또는 JSON `retry_after` 값을 따르고, 408/5xx/네트워크 오류는 지수 backoff와 jitter를 적용한다. 일반 backoff는 60초부터 최대 6시간까지 증가하며 시도는 최대 8회다. 429는 제공된 retry 시간을 사용한다. 408/429/5xx 외 4xx는 `dead` 처리해 잘못된 요청을 자동 반복하지 않는다. webhook이 없거나 URL 형식/도메인이 올바르지 않으면 delivery를 건드리지 않아 secret 설정 뒤에 처리할 수 있다. Discord 요청에는 `wait=true`를 붙이고 `allowed_mentions.parse=[]`로 사용자 입력이 mention을 발생시키지 않게 한다. 오류 응답 본문과 fetch 예외를 저장하지 않아 webhook token이 기록에 섞이지 않도록 한다.

이 outbox는 동시 Cron invocation의 중복 claim을 막고, 2xx 확인 뒤 sent 상태를 기록한다. Discord Webhook 실행 API에 요청 멱등성 키가 없어 Discord가 메시지를 만든 직후 Worker가 죽고 D1의 sent 갱신을 못 한 경우에는 lease 회수 후 재전송되어 중복될 수 있다. 따라서 외부 채널 전달은 at-least-once이며 exactly-once를 보장하지 않는다. 운영자가 설정하는 mute/snooze 정책은 이번 단계 범위가 아니고, alert dedupe 및 `(alert, channel, notification_type)` 유일성으로 반복 생성/전송만 억제한다.

**검증:** mock Discord의 성공/429 header·body/5xx/timeout/permanent 4xx, 재호출 사이 D1 재시도 지속, 8회 retry 제한, 겹친 Cron의 동시 claim, 한 delivery 실패 뒤 다른 delivery 처리, recovery outbox 단 1회와 ingest timeout resolve, webhook 미설정.

**완료:** alert 행과 외부 delivery 결과가 D1에서 구분되며 일시 장애 뒤 outbox를 재개한다. 실제 Cloudflare 계정 배포와 live Discord 전송은 수행하지 않았다.

### 7단계 — Repository stats와 이상 증가 탐지

**작업:** Bash Reporter는 성공한 `restic stats --mode restore-size|raw-data --json`에서 `total_size`를 읽어 언어 중립적인 `repository_stats` 결과로 전송한다. 모드가 생략/중복/지원 불가거나 stdout이 유효한 단일 JSON 객체가 아니면 측정값을 보내지 않는다. stats 실행 실패도 시계열에 넣지 않는다. API는 run, 이벤트, Repository 측정, 경보 상태와 outbox 전달 행을 한 D1 batch로 반영한다. 측정은 Repository·Job·mode별로 분리하며 같은 실행/종류의 D1 ID를 써 재전송을 멱등 처리한다. 성공한 stats 측정만 보관하고 400일이 지난 값은 새 측정 시 최대 100행씩 제거한다. D1에는 Job ID와 이상 여부를 저장하고, backend 물리 용량은 별도 수집기가 없으면 “미측정”으로 둔다.

이상 기준은 같은 Job·Repository·mode의 최근 400일 중 직전 정상 측정 최대 7개의 중앙값이다. 정상 표본이 5개 미만이면 경보하지 않는다. 기준보다 50% 이상, 동시에 100MiB 이상 증가하면 warning 경보를 연다. 경보가 열린 동안에는 그 경보의 기준값을 고정하고 추가 이상 측정은 표시만 하며 중복 경보를 만들지 않는다. 최신 시점 측정이 기준 아래로 내려가면 경보를 resolve하고 복구 알림을 outbox에 넣는다. 뒤늦게 도착한 오래된 측정은 경보 생명주기를 변경하지 않는다. 이상 표본은 이후 baseline에서 제외한다.

**검증:** Restic 0.19.1 fixture, 명시적 mode와 잘못된/누락 mode, unsafe counter 및 실패 실행, 같은 측정 재전송, 5개 미만 표본, 성장·경보 억제·복구, 오래된 이벤트 순서, Job/mode 분리, stats 시계열과 `bytes_added` 구분, read API와 대시보드 표시를 검증한다. Fixture는 공식 문서의 형태를 재현한 합성 데이터이므로 실제 저장소 출력 검증은 8단계 파일럿에서 수행한다.

**완료:** Repository 시계열이 백업 추가량과 구분되고 동일한 의미의 측정끼리 비교된다. backend 물리 용량은 측정한 것처럼 표시되지 않는다.

**상태:** 2026-10-11 구현 및 로컬 검증 완료. 운영 Repository의 실제 Restic 출력과 Cloudflare 배포 검증은 8단계 파일럿에서 수행한다.

### 8단계 — Docker/cron 통합 검증과 한 Host 파일럿

**준비 완료:** 저장소 안에 기존 Docker 이미지에 덧붙이는 opt-in Restic command shim, Compose override 예제와 fake Restic 테스트를 추가했다. 기존 컨테이너 cron 문자열과 명령행은 이 예제에서 바꾸지 않는다. shim은 기본 비활성이고, `forget --prune`도 프로토콜의 `forget_prune`으로 분류한다. 이 검증은 실제 Host 구성이나 Repository를 읽거나 바꾸지 않는다.

**남은 작업:** 실제 백업 구성을 소유자가 제공한 범위에서 확인하고 최소 wrapper 변경을 제안한다. 별도 테스트 Repository 또는 허용된 안전 대상에서 end-to-end를 검증한 뒤 한 Host에 opt-in 적용한다. 실제 Host와 Repository 실행은 대상 및 안전한 검증 범위가 정해진 승인이 있어야 하며, 기존 cron은 결과와 전송이 검증되기 전까지 유지한다.

Compose 예제는 `backup`, `prune`, `check` 서비스용이다. 이미지 기본 실행 사용자와 일치하도록 `RESTIC_RUNTIME_USER`를 지정하고, Reporter token은 Compose secret 파일로 제공한다. Restic Reporter에 필요한 `bash`, `coreutils`, `curl`, `jq`는 overlay 이미지에 설치한다. 기존 6-field cron의 첫 번째 seconds 필드가 `0`일 때만 그 필드를 제거해 Worker의 5-field Job schedule로 옮길 수 있다. seconds 값이 0이 아니면 동일한 분 단위 schedule이 아니므로 파일럿 전에 감시 표현을 따로 정해야 한다. `stats` 호출은 인식하지만 새 통계를 예약하지 않는다.

**검증:** 로컬 fake Restic으로 shim opt-in/off, stdout/stderr/argv/종료 코드 보존, 성공·부분·실패 이벤트, `forget --prune` 분류를 검사한다. Host 파일럿에서는 컨테이너 재시작, 네트워크 차단, D1/API 오류, Restic 실패/부분 실패, spool 회수, 기존 cron 결과 비교를 수행하고 적용 전후 백업의 종료 코드와 산출물이 같은지 확인한다.

**상태:** 저장소 내 통합 adapter와 fake Restic 테스트를 준비했다. Alpine 기반 이미지 빌드와 컨테이너 안에서 Restic 0.19.1 `version` passthrough을 확인했다. 빌드 context는 `.dockerignore` 추가 뒤 약 294 MiB에서 481 KiB로 줄었다. 이 환경에는 Docker Compose plugin이 없어 override merge/interpolation 검증은 못 했고 YAML 문법만 PyYAML로 읽었다. 실제 Host/Repository/Cloudflare 검증과 한 Host 완료 조건은 미수행이며 대상과 안전 범위를 확정한 뒤 진행한다.

### Go Reporter — 별도 후속 단계

프로토콜과 Bash 구현을 먼저 안정화한다. Go는 같은 JSON Schema, fixture, endpoint, exit code, spool semantics에 대한 conformance test를 통과해야 한다. Go를 도입해도 Worker, D1, 대시보드 API는 바꾸지 않는다.

## MVP 완료 범위

MVP는 단계 1~6과 한 Host 파일럿까지다. 백업 실행 수집, 부분 성공, 재전송 및 중복 방지, 최소 실행 이력 화면, 예정 실행 미감지, timeout 및 Discord 알림을 포함한다. 고급 이상 탐지, Telegram/다중 채널, 설정 CRUD 전체, Go 클라이언트, 복구 테스트 관리와 데이터 내보내기는 후속이다.

## 구현 전에 다시 확인할 운영 결정

아래는 백업 스크립트와 운영 구성을 살펴볼 때 확정한다. 지금 수집 API 구현을 막는 질문은 아니다.

- 실제 Host 수, Restic 버전과 주로 쓰는 명령 조합
- 각 Job의 cron 표현식, timezone, grace/timeout 값
- 여러 Repository의 논리 키와 한 Job의 다중 작업을 묶을 workflow 규칙
- 원격 상태/요약 보존 기간과 로컬 spool 용량 상한
- 기존 Healthchecks.io heartbeat를 유지할 기간과 Discord 목적지
- Cloudflare Access 도메인/worker.dev 노출 여부와 운영 계정의 무료 사용량

## 공식 문서

문서와 한도는 구현 시점에 다시 확인한다. 아래는 2026-10-11 검토 기준이다.

- Restic [Scripting 및 JSON 출력 (stable 0.19.1)](https://restic.readthedocs.io/en/stable/075_scripting.html)
- Restic [stats mode 의미](https://restic.readthedocs.io/en/stable/manual_rest.html)
- Cloudflare [Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [first test guide](https://developers.cloudflare.com/workers/testing/vitest-integration/write-your-first-test/), [test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)
- Cloudflare [D1 Worker API](https://developers.cloudflare.com/d1/worker-api/d1-database/), [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/), [Wrangler D1 commands](https://developers.cloudflare.com/d1/wrangler-commands/)
- Cloudflare [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
- Discord [webhook execution](https://discord.com/developers/docs/resources/webhook), [rate limits](https://discord.com/developers/docs/topics/rate-limits)
- Cloudflare [Worker TypeScript types](https://developers.cloudflare.com/workers/languages/typescript/#generate-types)
- Cloudflare [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- Cloudflare [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- Cloudflare [Scheduled handler](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/)
- Cloudflare D1 [limits](https://developers.cloudflare.com/d1/platform/limits/)
- Cloudflare D1 [pricing and Free daily read/write limits](https://developers.cloudflare.com/d1/platform/pricing/)
- Cloudflare D1 [Free 한도 초과 처리 FAQ](https://developers.cloudflare.com/d1/reference/faq/)
- Cloudflare D1 [Worker Binding API 및 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)
- Cloudflare D1 [prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/)
- Cloudflare Access [Application token validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)
- Cloudflare Access [applications and application types](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/), [application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- Cloudflare Workers [static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) and [static asset headers](https://developers.cloudflare.com/workers/static-assets/headers/)
