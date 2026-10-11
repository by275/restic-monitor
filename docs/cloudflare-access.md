# Dashboard 접근 보호

Dashboard 사용자 인증은 Worker 코드가 아니라 Cloudflare Access edge policy가 담당한다. `/api/v1/read/*`는 `ADMIN_HOST`와 요청 URL의 hostname이 정확히 일치해야 동작하지만, 이 검사는 Access 로그인 인증을 대신하지 않는다.

## 권장 hostname 분리

운영에서는 같은 Worker에 서로 다른 두 hostname을 연결한다.

- Dashboard: `monitor.example.com`
- Reporter ingest: `ingest.example.com`

Wrangler/Cloudflare dashboard에서 두 custom domain을 Worker에 연결하고, Worker의 `ADMIN_HOST` 변수를 `monitor.example.com`으로 설정한다. 변수에는 scheme, port, path를 넣지 않는다. 기본 `localhost` 값은 로컬 개발용이며, 배포 전에 운영 hostname으로 바꿔야 한다. 값이 비어 있거나 hostname과 다르면 read API는 404를 돌려준다.

Cloudflare One에서 `monitor.example.com`을 보호하는 Self-hosted Access application을 만들고 조직의 사용자 또는 허용 이메일을 대상으로 Allow policy를 설정한다. Application hostname 전체를 보호하면 정적 dashboard 파일과 read API가 함께 Access 정책을 통과한다. Dashboard hostname에는 공개 Bypass policy를 추가하지 않는다.

Reporters에는 `https://ingest.example.com`을 `RESTIC_MONITOR_API_URL`로 지정한다. 이 hostname은 Access login으로 막지 않고 `POST /api/v1/ingest/events`의 Host 범위 Bearer token 인증을 사용한다. `ingest.example.com` 및 `workers.dev` hostname에서 `/api/v1/read/*`를 요청하면 `ADMIN_HOST` 검사에서 404가 반환된다.

`workers.dev` URL을 유지해도 읽기 API hostname 검사는 적용된다. 운영에서 ingest를 custom domain으로 이전한 뒤 `workers.dev`를 사용하지 않는다면 Worker 설정에서 해당 route를 끌 수 있다. Dashboard URL을 브라우저에서 열어 Access login을 직접 확인하고, 로그인하지 않은 세션에서는 HTML/JS/CSS와 read API 모두 차단되는지 점검한다.

## 로컬 개발

`wrangler dev`는 `ADMIN_HOST=localhost`로 실행되며 Cloudflare Access를 시뮬레이션하지 않는다. 로컬 API smoke test를 위해 외부에 개발 서버를 노출하지 않는다. Access policy와 identity provider는 Cloudflare 계정 설정이므로 자동화된 로컬 D1 테스트 범위에 포함되지 않는다.

참고 문서: Cloudflare [Access applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/), [Self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/choose-application-type/), [Access application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), [Workers static asset routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/).
