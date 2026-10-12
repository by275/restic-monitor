# Restic Monitor 작업 지침

## 제품 범위

- 핵심 제품은 서버 설정 UI, ping API, D1 기록, 일정 감지, 알림이다.
- Restic Reporter 구현은 제품 필수 범위가 아니다. Bash와 PowerShell은 계약을 보여주는 작은 예제로만 제공한다.
- 새 ping API는 `/api/v1/` 아래에서 계속 v1로 제공한다. 아직 사용 중인 배포가 없으므로 이전 프로토콜 호환성은 유지하지 않아도 된다.
- 개발 D1은 필요하면 초기화할 수 있다. 기존 배포 데이터 보존용 schema migration/backfill은 요구하지 않는다. 빈 D1을 만드는 초기 schema는 유지한다.
- 기존 `docker-restic` 저장소에는 접근하거나 변경하지 않는다. 관련 예제와 테스트는 현재 `restic-monitor` 저장소 안에서만 관리한다.

## Client와 API 계약

- Job, operation, repository, schedule, notification 설정은 서버 UI에 저장한다. 클라이언트가 매번 이 설정을 payload에 반복하지 않는다.
- 클라이언트는 Job ping URL과 한 실행당 `run_id` 하나를 사용한다. 시작/완료 구분은 endpoint 경로로 한다. `event_id`, `workflow_id`, `event_type`, `job_key`, `repository_key`, `schema_version`, 클라이언트 timestamp/duration은 ping body에 요구하지 않는다.
- 완료 요청은 Restic exit code를 필수로 받고, Restic 버전/허용된 summary metrics/error summary는 선택 필드로 받는다.
- 동일 run의 재시도는 같은 URL과 같은 body를 재사용한다. 시작은 run ID로 멱등 처리하고, 같은 완료 body는 중복 수락하며 다른 완료 body는 충돌로 거부한다.
- ping URL의 token은 권한을 가진 비밀이다. 원문을 DB나 로그에 저장하지 않고, UI에서 생성 또는 회전 시 한 번만 보여준다.
- 원시 stdout/stderr, 경로, 저장소 URL, 비밀번호와 credential은 전송하거나 저장하지 않는다. 오류 요약은 제한·정리한다.
- D1은 prepared statements, 제약 조건, 필요한 인덱스를 사용한다.

## Job과 감시

- Job은 독립된 명령, 일정, 결과 및 알림 단위다. backup과 prune처럼 독립 실행되는 작업은 별도 Job으로 구성한다.
- 같은 작업의 여러 cron 규칙은 한 Job에 연결할 수 있다. 일정 종류 모델은 확장 가능하게 두되 초기 구현은 표준 5-field cron과 IANA timezone만 평가한다.
- 시작 지연 유예와 최대 실행 시간은 별도 설정한다.
- Worker Cron은 Restic을 실행하지 않는다. 예정 실행 누락, 실행 timeout, Discord outbox 재시도를 처리한다.
- 기존 exit code 상태 매핑과 Repository stats 이상 감지를 유지한다. backend 물리 사용량을 Restic 통계로 추정하지 않는다.

## 검증과 변경

- 각 구현 단계는 `docs/implementation-plan.md`의 완료 조건을 만족해야 한다.
- 각 단계마다 mock 입력과 격리된 D1을 사용하는 테스트를 작성하고 실행한다. 실제 백업 저장소, 운영 endpoint, Docker host를 테스트에 요구하지 않는다.
- 단계 경계마다 Git commit을 만든다. 테스트 실패와 알려진 제한은 단계 완료 보고에 기록한다.
- 공식 Restic JSON/exit code 또는 Cloudflare runtime 동작을 구현에 반영하기 전 공식 문서를 확인한다.
