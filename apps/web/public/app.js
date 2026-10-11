const state = {
  repositories: [],
  runCursor: null,
  selectedRepository: null,
  selectedRuns: [],
};

const elements = {
  error: document.querySelector("#page-error"),
  updatedAt: document.querySelector("#updated-at"),
  hostFilter: document.querySelector("#host-filter"),
  repositoryFilter: document.querySelector("#repository-filter"),
  statusFilter: document.querySelector("#status-filter"),
  measurementFilter: document.querySelector("#measurement-filter"),
  runsBody: document.querySelector("#runs-body"),
  hostsList: document.querySelector("#hosts-list"),
  repositoriesList: document.querySelector("#repositories-list"),
  loadMore: document.querySelector("#load-more"),
  runDialog: document.querySelector("#run-dialog"),
  runDetail: document.querySelector("#run-detail"),
};

const labels = {
  running: "실행 중",
  success: "성공",
  partial_success: "부분 성공",
  failed: "실패",
  timed_out: "시간 초과",
  cancelled: "취소",
  backup: "백업",
  forget: "정리",
  prune: "정리 공간 회수",
  forget_prune: "정리 및 공간 회수",
  copy: "복사",
  stats: "통계",
  check: "검사",
  restore: "복원",
  restic_restore_size: "복원 크기",
  restic_raw_data: "Restic 원시 데이터",
  backend_physical_bytes: "백엔드 실제 사용량 (미수집)",
};

async function api(path) {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `요청 실패 (${response.status})`);
  }
  return response.json();
}

function node(tag, className, value) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (value !== undefined && value !== null) element.textContent = String(value);
  return element;
}

function formatDate(value, includeTime = true) {
  if (value === null || value === undefined) return "—";
  const date = new Date(Number(value));
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("ko-KR", includeTime
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }
    : { year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return "—";
  const number = Number(value);
  if (number === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const index = Math.min(Math.floor(Math.log(Math.abs(number)) / Math.log(1024)), units.length - 1);
  const rounded = number / (1024 ** index);
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: index === 0 ? 0 : 1 }).format(rounded)} ${units[index]}`;
}

function formatDuration(value) {
  if (value === null || value === undefined) return "진행 중";
  const totalSeconds = Math.max(0, Math.floor(Number(value) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}초`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}분 ${seconds}초`;
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function setError(error) {
  elements.error.hidden = false;
  elements.error.textContent = `데이터를 불러오지 못했습니다: ${error.message}`;
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function queryString(values) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== "" && value !== null && value !== undefined) params.set(key, value);
  }
  return params.toString();
}

function currentFilters(includeStatus = true) {
  return {
    host_id: elements.hostFilter.value,
    repository_key: elements.repositoryFilter.value,
    ...(includeStatus ? { status: elements.statusFilter.value } : {}),
  };
}

async function loadDashboard() {
  clearError();
  elements.updatedAt.textContent = "새로고침 중";
  try {
    const filters = currentFilters(false);
    const [overview, hosts, repositories] = await Promise.all([
      api(`/api/v1/read/overview?${queryString(filters)}`),
      api("/api/v1/read/hosts?limit=100"),
      api("/api/v1/read/repositories?limit=100"),
    ]);
    renderOverview(overview);
    renderHosts(hosts.data);
    state.repositories = repositories.data;
    renderRepositoryOptions(repositories.data);
    renderRepositories(repositories.data);
    await loadRuns(true);
    if (state.selectedRepository === null && repositories.data.length > 0) {
      selectRepository(repositories.data[0].repository_key);
    } else if (state.selectedRepository !== null) {
      await loadStats();
    }
    elements.updatedAt.textContent = `갱신 ${new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date())}`;
  } catch (error) {
    elements.updatedAt.textContent = "연결 오류";
    setError(error);
  }
}

function renderOverview(overview) {
  const counts = overview.counts;
  document.querySelector("#count-total").textContent = counts.total_runs ?? 0;
  document.querySelector("#count-success").textContent = counts.success ?? 0;
  document.querySelector("#count-partial").textContent = counts.partial_success ?? 0;
  document.querySelector("#count-failed").textContent = Number(counts.failed ?? 0) + Number(counts.timed_out ?? 0) + Number(counts.cancelled ?? 0);
  document.querySelector("#count-hosts").textContent = counts.active_hosts ?? 0;
  document.querySelector("#count-repositories").textContent = counts.active_repositories ?? 0;
}

function setSelectOptions(select, rows, { value, label, initialLabel }) {
  const selected = select.value;
  select.replaceChildren(new Option(initialLabel, ""));
  for (const row of rows) select.add(new Option(label(row), value(row)));
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function renderRepositoryOptions(repositories) {
  setSelectOptions(elements.repositoryFilter, repositories, {
    value: (repository) => repository.repository_key,
    label: (repository) => repository.name,
    initialLabel: "전체 저장소",
  });
}

function renderHosts(hosts) {
  setSelectOptions(elements.hostFilter, hosts, {
    value: (host) => host.id,
    label: (host) => host.display_name,
    initialLabel: "전체 호스트",
  });
  document.querySelector("#hosts-count").textContent = `${hosts.length}개`;
  elements.hostsList.replaceChildren();
  if (hosts.length === 0) {
    elements.hostsList.append(node("p", "empty-state", "등록된 호스트가 없습니다."));
    return;
  }
  for (const host of hosts) {
    const row = node("div", "host-row");
    const identity = node("div", "host-identity");
    identity.append(node("span", "host-name", host.display_name));
    identity.append(node("span", "host-sub", `${host.jobs_count}개 작업 · ${host.enabled ? "활성" : "비활성"}`));
    const last = node("span", `host-state state-${host.last_run_status || "unknown"}`, host.last_run_status ? labels[host.last_run_status] || host.last_run_status : "실행 기록 없음");
    row.append(identity, last);
    elements.hostsList.append(row);
  }
}

function renderRepositories(repositories) {
  elements.repositoriesList.replaceChildren();
  if (repositories.length === 0) {
    elements.repositoriesList.append(node("p", "empty-state", "등록된 저장소가 없습니다."));
    return;
  }
  for (const repository of repositories) {
    const button = node("button", `repository-row${state.selectedRepository === repository.repository_key ? " selected" : ""}`);
    button.type = "button";
    button.setAttribute("aria-pressed", state.selectedRepository === repository.repository_key ? "true" : "false");
    const icon = node("span", "repository-icon", repository.backend_type.slice(0, 2).toUpperCase());
    icon.setAttribute("aria-hidden", "true");
    const identity = node("span", "repository-identity");
    identity.append(node("span", "repository-name", repository.name));
    identity.append(node("span", "repository-sub", `${repository.jobs_count}개 연결 작업 · ${repository.enabled ? "활성" : "비활성"}`));
    button.append(icon, identity);
    button.addEventListener("click", () => selectRepository(repository.repository_key));
    elements.repositoriesList.append(button);
  }
}

async function loadRuns(reset) {
  if (reset) {
    state.runCursor = null;
    state.selectedRuns = [];
    const loadingRow = node("tr");
    loadingRow.append(node("td", "empty-cell", "실행 이력을 불러오는 중입니다."));
    elements.runsBody.replaceChildren(loadingRow);
  }
  const params = { ...currentFilters(), limit: "25", ...(reset ? {} : { cursor: state.runCursor }) };
  const result = await api(`/api/v1/read/runs?${queryString(params)}`);
  state.runCursor = result.pagination.next_cursor;
  state.selectedRuns = [...state.selectedRuns, ...result.data];
  document.querySelector("#runs-count").textContent = `${state.selectedRuns.length}건 표시`;
  elements.loadMore.hidden = !result.pagination.has_more;
  renderRuns(reset ? result.data : state.selectedRuns, reset);
}

function renderRuns(runs, replace) {
  if (replace) elements.runsBody.replaceChildren();
  if (runs.length === 0 && replace) {
    elements.runsBody.append(node("tr", "", node("td", "empty-cell", "조건에 맞는 실행이 없습니다.")));
    return;
  }
  const offset = replace ? 0 : elements.runsBody.querySelectorAll("tr[data-run-id]").length;
  for (const [index, run] of runs.entries()) {
    if (!replace && index < offset) continue;
    const row = node("tr");
    row.dataset.runId = run.id;

    const dateCell = node("td");
    dateCell.append(node("span", "date-main", formatDate(run.started_at)));
    dateCell.append(node("span", "date-sub", formatDuration(run.duration_ms)));

    const jobCell = node("td");
    jobCell.append(node("span", "cell-title", run.job.name));
    jobCell.append(node("span", "cell-sub", run.host.display_name));

    const repoCell = node("td");
    const chips = node("div", "repo-chips");
    for (const repository of run.repositories) chips.append(node("span", "repo-chip", repository.repository_key));
    repoCell.append(chips);

    const statusCell = node("td");
    statusCell.append(node("span", `status-badge status-${run.status}`, labels[run.status] || run.status));
    const bytesCell = node("td", "", run.metrics?.bytes_added == null ? "—" : formatBytes(run.metrics.bytes_added));
    const actionCell = node("td");
    const detailButton = node("button", "button detail-button", "상세");
    detailButton.type = "button";
    detailButton.addEventListener("click", () => showRunDetail(run.id));
    actionCell.append(detailButton);
    row.append(dateCell, jobCell, repoCell, statusCell, bytesCell, actionCell);
    elements.runsBody.append(row);
  }
}

async function showRunDetail(runId) {
  elements.runDetail.replaceChildren(node("p", "empty-state", "실행 정보를 불러오는 중입니다."));
  elements.runDialog.showModal();
  try {
    const response = await api(`/api/v1/read/runs/${encodeURIComponent(runId)}`);
    renderRunDetail(response.data);
  } catch (error) {
    elements.runDetail.replaceChildren(node("p", "notice notice-error", error.message));
  }
}

function renderRunDetail(run) {
  document.querySelector("#dialog-title").textContent = `${run.job.name} · ${labels[run.operation] || run.operation}`;
  elements.runDetail.replaceChildren();
  const grid = node("div", "detail-grid");
  const details = [
    ["상태", labels[run.status] || run.status],
    ["호스트", run.host.display_name],
    ["시작", formatDate(run.started_at)],
    ["종료", formatDate(run.finished_at)],
    ["소요 시간", formatDuration(run.duration_ms)],
    ["종료 코드", run.exit_code ?? "—"],
    ["Restic 버전", run.client.restic_version || "기록되지 않음"],
    ["Run ID", run.id],
  ];
  for (const [label, value] of details) {
    const item = node("div", "detail-item");
    item.append(node("span", "", label), node("strong", "", value));
    grid.append(item);
  }
  elements.runDetail.append(grid);

  const repositorySection = node("section", "detail-section");
  repositorySection.append(node("h3", "", "저장소"));
  repositorySection.append(node("p", "", run.repositories.map((repository) => `${labels[repository.role] || repository.role}: ${repository.name} (${repository.repository_key})`).join(" · ") || "연결 저장소 없음"));
  elements.runDetail.append(repositorySection);

  const metricsSection = node("section", "detail-section");
  metricsSection.append(node("h3", "", "백업 지표"));
  const metrics = run.metrics;
  const metricText = metrics === null ? "기록된 지표가 없습니다." : [
    `처리한 데이터 ${formatBytes(metrics.bytes_processed)}`,
    `추가 데이터 ${formatBytes(metrics.bytes_added)}`,
    `압축 후 추가 ${formatBytes(metrics.bytes_added_packed)}`,
    `새 파일 ${metrics.files_new ?? "—"}`,
    `변경 파일 ${metrics.files_changed ?? "—"}`,
    `변경 없는 파일 ${metrics.files_unmodified ?? "—"}`,
  ].join(" · ");
  metricsSection.append(node("p", "", metricText));
  elements.runDetail.append(metricsSection);

  if (run.error_summary) {
    const errorSection = node("section", "detail-section");
    errorSection.append(node("h3", "", "오류 요약"), node("p", "", run.error_summary));
    elements.runDetail.append(errorSection);
  }
}

function selectRepository(repositoryKey) {
  state.selectedRepository = repositoryKey;
  renderRepositories(state.repositories);
  const repository = state.repositories.find((item) => item.repository_key === repositoryKey);
  document.querySelector("#chart-repository").textContent = repository?.name || repositoryKey;
  loadStats().catch(setError);
}

async function loadStats() {
  if (state.selectedRepository === null) return;
  const measurementType = elements.measurementFilter.value;
  const result = await api(`/api/v1/read/repositories/${encodeURIComponent(state.selectedRepository)}/stats?${queryString({ measurement_type: measurementType, limit: "100" })}`);
  document.querySelector("#chart-measurement").textContent = labels[measurementType] || measurementType;
  const latest = result.data[0];
  document.querySelector("#chart-latest").textContent = latest ? `${latest.is_anomalous ? "이상 증가 · " : ""}${formatBytes(latest.value_bytes)} · ${formatDate(latest.measured_at, false)}` : "측정값 없음";
  renderChart(result.data);
}

function renderChart(rows) {
  const target = document.querySelector("#stats-chart");
  target.replaceChildren();
  if (rows.length === 0) {
    target.append(node("p", "empty-state", "이 저장소에 해당하는 측정 데이터가 없습니다."));
    return;
  }
  const ordered = [...rows].reverse();
  const width = 760;
  const height = 160;
  const pad = { top: 13, right: 13, bottom: 24, left: 13 };
  const values = ordered.map((row) => Number(row.value_bytes));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max === min ? Math.max(max * .12, 1) : max - min;
  const innerWidth = width - pad.left - pad.right;
  const innerHeight = height - pad.top - pad.bottom;
  const points = values.map((value, index) => ({
    x: pad.left + (ordered.length === 1 ? innerWidth / 2 : index * innerWidth / (ordered.length - 1)),
    y: pad.top + innerHeight - ((value - min) / range) * innerHeight,
  }));

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("aria-hidden", "true");
  for (const ratio of [0, .5, 1]) {
    const y = pad.top + ratio * innerHeight;
    const line = document.createElementNS(svg.namespaceURI, "line");
    line.setAttribute("x1", String(pad.left));
    line.setAttribute("x2", String(width - pad.right));
    line.setAttribute("y1", String(y));
    line.setAttribute("y2", String(y));
    line.setAttribute("class", "chart-gridline");
    svg.append(line);
  }
  const pointString = points.map((point) => `${point.x},${point.y}`).join(" ");
  const area = document.createElementNS(svg.namespaceURI, "polygon");
  area.setAttribute("points", `${points[0].x},${height - pad.bottom} ${pointString} ${points.at(-1).x},${height - pad.bottom}`);
  area.setAttribute("class", "chart-area");
  const line = document.createElementNS(svg.namespaceURI, "polyline");
  line.setAttribute("points", pointString);
  line.setAttribute("class", "chart-line");
  const defs = document.createElementNS(svg.namespaceURI, "defs");
  const gradient = document.createElementNS(svg.namespaceURI, "linearGradient");
  gradient.id = "chart-fill";
  gradient.setAttribute("x1", "0");
  gradient.setAttribute("x2", "0");
  gradient.setAttribute("y1", "0");
  gradient.setAttribute("y2", "1");
  const top = document.createElementNS(svg.namespaceURI, "stop");
  top.setAttribute("offset", "0%");
  top.setAttribute("stop-color", "#54a9ff");
  top.setAttribute("stop-opacity", ".2");
  const bottom = document.createElementNS(svg.namespaceURI, "stop");
  bottom.setAttribute("offset", "100%");
  bottom.setAttribute("stop-color", "#54a9ff");
  bottom.setAttribute("stop-opacity", "0");
  gradient.append(top, bottom);
  defs.append(gradient);
  svg.append(defs, area, line);
  for (const [index, point] of points.entries()) {
    const circle = document.createElementNS(svg.namespaceURI, "circle");
    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", ordered[index].is_anomalous ? "4.5" : "3");
    circle.setAttribute("class", ordered[index].is_anomalous ? "chart-point chart-point-anomalous" : "chart-point");
    svg.append(circle);
  }
  const leftLabel = document.createElementNS(svg.namespaceURI, "text");
  leftLabel.setAttribute("x", String(pad.left));
  leftLabel.setAttribute("y", String(height - 4));
  leftLabel.setAttribute("class", "chart-axis");
  leftLabel.textContent = formatDate(ordered[0].measured_at, false);
  const rightLabel = document.createElementNS(svg.namespaceURI, "text");
  rightLabel.setAttribute("x", String(width - pad.right));
  rightLabel.setAttribute("y", String(height - 4));
  rightLabel.setAttribute("text-anchor", "end");
  rightLabel.setAttribute("class", "chart-axis");
  rightLabel.textContent = formatDate(ordered.at(-1).measured_at, false);
  svg.append(leftLabel, rightLabel);
  target.append(svg);
}

document.querySelector("#refresh-button").addEventListener("click", () => loadDashboard());
document.querySelector("#close-dialog").addEventListener("click", () => elements.runDialog.close());
elements.loadMore.addEventListener("click", async () => {
  elements.loadMore.disabled = true;
  try {
    await loadRuns(false);
  } catch (error) {
    setError(error);
  } finally {
    elements.loadMore.disabled = false;
  }
});
for (const select of [elements.hostFilter, elements.repositoryFilter, elements.statusFilter]) {
  select.addEventListener("change", () => loadDashboard());
}
elements.measurementFilter.addEventListener("change", () => loadStats().catch(setError));

loadDashboard();
