const state = {
  repositories: [],
  adminHosts: [],
  adminRepositories: [],
  adminNotificationTargets: [],
  adminJobs: [],
  editingHostId: null,
  editingRepositoryId: null,
  editingNotificationTargetId: null,
  editingJobId: null,
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
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

function formatDuration(value, isRunning = true) {
  if (value === null || value === undefined) return isRunning ? "진행 중" : "측정 불가";
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

function showAdminMessage(message, isError = false) {
  const target = document.querySelector("#admin-message");
  target.hidden = false;
  target.classList.toggle("error", isError);
  target.textContent = message;
}

async function loadManagement() {
  const [hosts, repositories, notificationTargets, jobs] = await Promise.all([
    api("/api/v1/admin/hosts"),
    api("/api/v1/admin/repositories"),
    api("/api/v1/admin/notification-targets"),
    api("/api/v1/admin/jobs"),
  ]);
  state.adminHosts = hosts.data;
  state.adminRepositories = repositories.data;
  state.adminNotificationTargets = notificationTargets.data;
  state.adminJobs = jobs.data;
  const editingJob = state.adminJobs.find((job) => job.id === state.editingJobId);
  renderAdminHostOptions(editingJob?.host_id ?? document.querySelector("#job-host").value);
  renderJobRepositoryFields(editingJob?.repositories ?? []);
  renderJobNotificationTargets(editingJob?.notification_targets.map((target) => target.id) ?? []);
  renderManagedInventory();
  renderAdminJobs();
}

function renderManagedInventory() {
  renderManagedHosts();
  renderManagedRepositories();
  renderManagedNotificationTargets();
}

function addResourceAction(actions, label, className, handler, disabled = false, title = "") {
  const button = node("button", className, label);
  button.type = "button";
  button.disabled = disabled;
  if (title) button.title = title;
  button.addEventListener("click", handler);
  actions.append(button);
}

function renderManagedHosts() {
  const list = document.querySelector("#host-management-list");
  list.replaceChildren();
  if (state.adminHosts.length === 0) {
    list.append(node("p", "empty-state", "등록된 호스트가 없습니다."));
    return;
  }
  for (const host of state.adminHosts) {
    const jobsCount = Number(host.jobs_count) || 0;
    const row = node("article", "admin-resource-row");
    const info = node("div", "admin-resource-info");
    info.append(node("span", "admin-resource-name", host.display_name));
    info.append(node("span", "admin-resource-sub", `${host.name} · ${jobsCount}개 작업 · ${host.enabled ? "선택 가능" : "새 작업에서 숨김"}`));
    const actions = node("div", "admin-job-actions");
    addResourceAction(actions, "수정", "button button-quiet", () => editHost(host));
    addResourceAction(
      actions,
      host.enabled ? "선택에서 숨김" : "다시 선택 허용",
      "button button-quiet",
      () => setHostEnabled(host, !host.enabled),
    );
    addResourceAction(
      actions,
      "삭제",
      "button button-quiet button-danger-quiet",
      () => deleteHost(host),
      jobsCount > 0,
      jobsCount > 0 ? "작업이 연결되어 있어 삭제할 수 없습니다. 연결 작업과 이력을 유지하려면 선택에서 숨기세요." : "",
    );
    row.append(info, actions);
    list.append(row);
  }
}

function renderManagedRepositories() {
  const list = document.querySelector("#repository-management-list");
  list.replaceChildren();
  if (state.adminRepositories.length === 0) {
    list.append(node("p", "empty-state", "등록된 저장소가 없습니다."));
    return;
  }
  for (const repository of state.adminRepositories) {
    const jobsCount = Number(repository.jobs_count) || 0;
    const runsCount = Number(repository.runs_count) || 0;
    const statsCount = Number(repository.stats_count) || 0;
    const inUse = jobsCount + runsCount + statsCount > 0;
    const row = node("article", "admin-resource-row");
    const info = node("div", "admin-resource-info");
    info.append(node("span", "admin-resource-name", repository.name));
    info.append(node("span", "admin-resource-sub", `${repository.repository_key} · ${jobsCount}개 작업 · ${repository.enabled ? "선택 가능" : "새 작업에서 숨김"}`));
    const actions = node("div", "admin-job-actions");
    addResourceAction(actions, "수정", "button button-quiet", () => editRepository(repository));
    addResourceAction(
      actions,
      repository.enabled ? "선택에서 숨김" : "다시 선택 허용",
      "button button-quiet",
      () => setRepositoryEnabled(repository, !repository.enabled),
    );
    addResourceAction(
      actions,
      "삭제",
      "button button-quiet button-danger-quiet",
      () => deleteRepository(repository),
      inUse,
      inUse ? `연결된 사용 기록이 있습니다 (${jobsCount}개 작업, ${runsCount}개 실행, ${statsCount}개 측정값).` : "",
    );
    row.append(info, actions);
    list.append(row);
  }
}

function renderManagedNotificationTargets() {
  const list = document.querySelector("#notification-target-list");
  list.replaceChildren();
  if (state.adminNotificationTargets.length === 0) {
    list.append(node("p", "empty-state", "등록된 알림 대상이 없습니다."));
    return;
  }
  for (const target of state.adminNotificationTargets) {
    const jobsCount = Number(target.jobs_count) || 0;
    const row = node("article", "admin-resource-row");
    const info = node("div", "admin-resource-info");
    info.append(node("span", "admin-resource-name", target.name));
    info.append(node("span", "admin-resource-sub", `${target.provider === "telegram" ? "Telegram" : "Discord"} · ${jobsCount}개 작업 · ${target.enabled ? "사용 중" : "비활성"} · 연결 정보 저장됨`));
    const actions = node("div", "admin-job-actions");
    addResourceAction(actions, "수정", "button button-quiet", () => editNotificationTarget(target));
    addResourceAction(
      actions,
      target.enabled ? "비활성화" : "사용",
      "button button-quiet",
      () => setNotificationTargetEnabled(target, !target.enabled),
    );
    addResourceAction(
      actions,
      "삭제",
      "button button-quiet button-danger-quiet",
      () => deleteNotificationTarget(target),
      jobsCount > 0,
      jobsCount > 0 ? `${jobsCount}개 작업에서 사용 중입니다. 작업에서 연결을 해제한 뒤 삭제하세요.` : "",
    );
    row.append(info, actions);
    list.append(row);
  }
}

function editNotificationTarget(target) {
  resetRepositoryForm();
  const form = document.querySelector("#notification-target-form");
  state.editingNotificationTargetId = target.id;
  form.elements.namedItem("name").value = target.name;
  form.elements.namedItem("provider").value = target.provider;
  form.elements.namedItem("provider").disabled = true;
  form.elements.namedItem("enabled").checked = Boolean(target.enabled);
  form.elements.namedItem("webhook_url").value = "";
  form.elements.namedItem("bot_token").value = "";
  form.elements.namedItem("chat_id").value = "";
  document.querySelector("#notification-target-help").textContent = "연결 정보 입력란을 비워 두면 기존 값을 유지합니다. 종류 변경은 작업에서 연결을 해제한 뒤 대상을 새로 등록하세요.";
  document.querySelector("#cancel-notification-target-edit").hidden = false;
  renderNotificationTargetFields();
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetNotificationTargetForm() {
  const form = document.querySelector("#notification-target-form");
  state.editingNotificationTargetId = null;
  form.reset();
  form.elements.namedItem("provider").disabled = false;
  form.elements.namedItem("enabled").checked = true;
  document.querySelector("#notification-target-help").textContent = "연결 정보는 서버에 저장되며 목록과 작업 설정에는 표시되지 않습니다.";
  document.querySelector("#cancel-notification-target-edit").hidden = true;
  renderNotificationTargetFields();
}

function renderNotificationTargetFields() {
  const provider = document.querySelector("#notification-provider").value;
  document.querySelector("#discord-target-fields").hidden = provider !== "discord";
  document.querySelector("#telegram-target-fields").hidden = provider !== "telegram";
}

function renderJobNotificationTargets(selectedIds = []) {
  const target = document.querySelector("#job-notification-targets");
  const selected = new Set(selectedIds);
  target.replaceChildren();
  const available = state.adminNotificationTargets.filter((item) => item.enabled || selected.has(item.id));
  if (available.length === 0) {
    target.append(node("p", "empty-state", "선택 가능한 알림 대상이 없습니다."));
    return;
  }
  for (const item of available) {
    const label = node("label", "notification-option");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.name = "notification_target_ids";
    checkbox.value = item.id;
    checkbox.checked = selected.has(item.id);
    label.append(checkbox, node("span", "", `${item.name} · ${item.provider === "telegram" ? "Telegram" : "Discord"}${item.enabled ? "" : " · 비활성 대상"}`));
    target.append(label);
  }
}

async function setNotificationTargetEnabled(target, enabled) {
  const message = enabled ? "다시 사용" : "비활성화";
  if (!confirm(`알림 대상 '${target.name}'을(를) ${message}할까요? 비활성화하면 새 알림은 만들지 않고 대기 중 전송도 멈춥니다.`)) return;
  try {
    await api(`/api/v1/admin/notification-targets/${encodeURIComponent(target.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name: target.name, provider: target.provider, enabled }),
    });
    await loadManagement();
    showAdminMessage(enabled ? "알림 대상을 다시 사용합니다." : "알림 대상을 비활성화했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

async function deleteNotificationTarget(target) {
  if (!confirm(`알림 대상 '${target.name}'을(를) 삭제할까요? 연결 작업이 없어야 삭제할 수 있고, 대기 중인 전송은 중단됩니다.`)) return;
  try {
    await api(`/api/v1/admin/notification-targets/${encodeURIComponent(target.id)}`, { method: "DELETE" });
    await loadManagement();
    showAdminMessage("알림 대상을 삭제했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

function editHost(host) {
  resetRepositoryForm();
  const form = document.querySelector("#host-form");
  state.editingHostId = host.id;
  form.elements.namedItem("name").value = host.name;
  form.elements.namedItem("name").disabled = true;
  form.elements.namedItem("display_name").value = host.display_name;
  document.querySelector("#host-form-title").textContent = `호스트 수정 · ${host.display_name}`;
  document.querySelector("#host-submit").textContent = "호스트 저장";
  document.querySelector("#cancel-host-edit").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetHostForm() {
  const form = document.querySelector("#host-form");
  state.editingHostId = null;
  form.reset();
  form.elements.namedItem("name").disabled = false;
  document.querySelector("#host-form-title").textContent = "호스트 등록";
  document.querySelector("#host-submit").textContent = "호스트 추가";
  document.querySelector("#cancel-host-edit").hidden = true;
}

function editRepository(repository) {
  resetHostForm();
  const form = document.querySelector("#repository-form");
  state.editingRepositoryId = repository.id;
  form.elements.namedItem("repository_key").value = repository.repository_key;
  form.elements.namedItem("repository_key").disabled = true;
  form.elements.namedItem("name").value = repository.name;
  form.elements.namedItem("backend_type").value = repository.backend_type;
  document.querySelector("#repository-form-title").textContent = `저장소 수정 · ${repository.name}`;
  document.querySelector("#repository-submit").textContent = "저장소 저장";
  document.querySelector("#cancel-repository-edit").hidden = false;
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetRepositoryForm() {
  const form = document.querySelector("#repository-form");
  state.editingRepositoryId = null;
  form.reset();
  form.elements.namedItem("repository_key").disabled = false;
  document.querySelector("#repository-form-title").textContent = "저장소 등록";
  document.querySelector("#repository-submit").textContent = "저장소 추가";
  document.querySelector("#cancel-repository-edit").hidden = true;
}

async function setHostEnabled(host, enabled) {
  const action = enabled ? "다시 선택할 수 있게" : "새 작업에서 숨기게";
  if (!confirm(`호스트 '${host.display_name}'를 ${action} 설정할까요? 기존 작업과 이력은 유지됩니다.`)) return;
  try {
    await api(`/api/v1/admin/hosts/${encodeURIComponent(host.id)}`, {
      method: "PUT",
      body: JSON.stringify({ display_name: host.display_name, enabled }),
    });
    await loadManagement();
    await loadDashboard();
    showAdminMessage(enabled ? "호스트를 다시 선택할 수 있습니다." : "호스트를 새 작업 선택에서 숨겼습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

async function setRepositoryEnabled(repository, enabled) {
  const action = enabled ? "다시 선택할 수 있게" : "새 작업에서 숨기게";
  if (!confirm(`저장소 '${repository.name}'를 ${action} 설정할까요? 기존 작업과 이력은 유지됩니다.`)) return;
  try {
    await api(`/api/v1/admin/repositories/${encodeURIComponent(repository.id)}`, {
      method: "PUT",
      body: JSON.stringify({ name: repository.name, backend_type: repository.backend_type, enabled }),
    });
    await loadManagement();
    await loadDashboard();
    showAdminMessage(enabled ? "저장소를 다시 선택할 수 있습니다." : "저장소를 새 작업 선택에서 숨겼습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

async function deleteHost(host) {
  if (!confirm(`호스트 '${host.display_name}'를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/v1/admin/hosts/${encodeURIComponent(host.id)}`, { method: "DELETE" });
    await loadManagement();
    await loadDashboard();
    showAdminMessage("호스트를 삭제했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

async function deleteRepository(repository) {
  if (!confirm(`저장소 '${repository.name}'를 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await api(`/api/v1/admin/repositories/${encodeURIComponent(repository.id)}`, { method: "DELETE" });
    await loadManagement();
    await loadDashboard();
    showAdminMessage("저장소를 삭제했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
}

function renderAdminHostOptions(selected = document.querySelector("#job-host").value) {
  const select = document.querySelector("#job-host");
  select.replaceChildren(new Option("호스트 선택", ""));
  for (const host of state.adminHosts) {
    if (host.enabled || host.id === selected) {
      const option = new Option(`${host.display_name}${host.enabled ? "" : " (숨김)"}`, host.id);
      select.add(option);
    }
  }
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

function renderJobRepositoryFields(selection = []) {
  const target = document.querySelector("#job-repository-fields");
  const operation = document.querySelector("#job-operation").value;
  const roles = operation === "copy" ? ["source", "target"] : ["repository"];
  target.replaceChildren();
  for (const role of roles) {
    const label = node("label", "", operation === "copy" ? `${role === "source" ? "원본" : "대상"} 저장소` : "저장소");
    const select = document.createElement("select");
    select.required = true;
    select.dataset.role = role;
    select.append(new Option("저장소 선택", ""));
    const chosen = selection.find((item) => item.role === role)?.repository_id;
    for (const repository of state.adminRepositories) {
      if (repository.enabled || repository.id === chosen) {
        select.add(new Option(
          `${repository.name} (${repository.repository_key})${repository.enabled ? "" : " · 숨김"}`,
          repository.id,
        ));
      }
    }
    if (chosen) select.value = chosen;
    label.append(select);
    target.append(label);
  }
}

function renderAdminJobs() {
  const list = document.querySelector("#admin-jobs-list");
  list.replaceChildren();
  if (state.adminJobs.length === 0) {
    list.append(node("p", "empty-state", "등록된 작업이 없습니다."));
    return;
  }
  for (const job of state.adminJobs) {
    const row = node("article", "admin-job-row");
    const info = node("div", "admin-job-info");
    info.append(node("span", "admin-job-name", `${job.name} · ${job.host_name}`));
    const schedule = job.schedules.map((item) => `${item.expression} (${item.timezone}, grace ${item.start_grace_seconds}s)`).join(" · ");
    const repos = job.repositories.map((item) => item.repository_key).join(", ");
    const notificationNames = job.notification_targets.length
      ? job.notification_targets.map((target) => `${target.name}${target.enabled ? "" : " (비활성)"}`).join(", ")
      : "알림 없음";
    info.append(node("span", "admin-job-sub", `${job.slug} · ${job.operation} · ${repos} · ${schedule} · ${job.enabled ? "활성" : "비활성"} · 알림: ${notificationNames}`));
    const actions = node("div", "admin-job-actions");
    const edit = node("button", "button button-quiet", "수정");
    edit.type = "button";
    edit.addEventListener("click", () => editJob(job));
    const rotate = node("button", "button button-quiet", "Ping URL 교체");
    rotate.type = "button";
    rotate.addEventListener("click", () => rotateJobToken(job));
    actions.append(edit, rotate);
    row.append(info, actions);
    list.append(row);
  }
}

function editJob(job) {
  const form = document.querySelector("#job-form");
  state.editingJobId = job.id;
  document.querySelector("#job-form-title").textContent = `작업 수정 · ${job.name}`;
  document.querySelector("#cancel-job-edit").hidden = false;
  renderAdminHostOptions(job.host_id);
  form.elements.namedItem("host_id").value = job.host_id;
  form.elements.namedItem("host_id").disabled = true;
  form.elements.namedItem("name").value = job.name;
  form.elements.namedItem("slug").value = job.slug;
  form.elements.namedItem("operation").value = job.operation;
  form.elements.namedItem("max_runtime_seconds").value = job.max_runtime_seconds;
  form.elements.namedItem("tags").value = job.tags.join(", ");
  form.elements.namedItem("description").value = job.description;
  form.elements.namedItem("schedules").value = job.schedules.map((item) =>
    `${item.expression}|${item.timezone}|${item.start_grace_seconds}`,
  ).join("\n");
  form.elements.namedItem("enabled").checked = job.enabled;
  renderJobRepositoryFields(job.repositories);
  renderJobNotificationTargets(job.notification_targets.map((target) => target.id));
  form.scrollIntoView({ behavior: "smooth", block: "center" });
}

function resetJobForm() {
  const form = document.querySelector("#job-form");
  state.editingJobId = null;
  form.reset();
  form.elements.namedItem("host_id").disabled = false;
  document.querySelector("#job-form-title").textContent = "작업 등록";
  document.querySelector("#cancel-job-edit").hidden = true;
  form.elements.namedItem("max_runtime_seconds").value = "14400";
  form.elements.namedItem("schedules").value = "0 3 * * *|Asia/Seoul|600";
  renderAdminHostOptions("");
  renderJobRepositoryFields();
  renderJobNotificationTargets();
}

function parseScheduleLines(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length || lines.length > 16) throw new Error("Cron 규칙은 1개 이상, 16개 이하로 입력하세요.");
  return lines.map((line) => {
    const [expression, timezone, grace, ...extra] = line.split("|").map((part) => part.trim());
    if (!expression || !timezone || grace === undefined || extra.length > 0 || !/^\d+$/.test(grace)) {
      throw new Error(`잘못된 Cron 규칙입니다: ${line}`);
    }
    return { schedule_type: "cron", expression, timezone, start_grace_seconds: Number(grace) };
  });
}

function jobFormPayload(form) {
  const value = (name) => form.elements.namedItem(name).value.trim();
  const payload = {
    host_id: value("host_id"),
    name: value("name"),
    slug: value("slug") || undefined,
    description: value("description"),
    operation: value("operation"),
    max_runtime_seconds: Number(value("max_runtime_seconds")),
    tags: value("tags").split(",").map((tag) => tag.trim()).filter(Boolean),
    notification_target_ids: [...form.querySelectorAll('input[name="notification_target_ids"]:checked')]
      .map((checkbox) => checkbox.value),
    enabled: form.elements.namedItem("enabled").checked,
    repositories: [...form.querySelectorAll("select[data-role]")].map((select) => ({
      repository_id: select.value,
      role: select.dataset.role,
    })),
    schedules: parseScheduleLines(value("schedules")),
  };
  return payload;
}

function showPingUrl(url) {
  document.querySelector("#ping-url-value").textContent = url;
  document.querySelector("#ping-url-dialog").showModal();
}

async function rotateJobToken(job) {
  if (!window.confirm(`${job.name}에 연결된 기존 Ping URL을 폐기하고 새 URL을 만들까요?`)) return;
  try {
    const result = await api(`/api/v1/admin/jobs/${encodeURIComponent(job.id)}/rotate-ping-token`, { method: "POST" });
    showPingUrl(result.ping_url);
    showAdminMessage(`${job.name}의 Ping URL을 교체했습니다. 이전 URL은 더 이상 사용할 수 없습니다.`);
  } catch (error) {
    showAdminMessage(error.message, true);
  }
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
    const emptyRow = node("tr");
    const emptyCell = node("td", "empty-cell", "조건에 맞는 실행이 없습니다.");
    emptyCell.colSpan = 6;
    emptyRow.append(emptyCell);
    elements.runsBody.append(emptyRow);
    return;
  }
  const offset = replace ? 0 : elements.runsBody.querySelectorAll("tr[data-run-id]").length;
  for (const [index, run] of runs.entries()) {
    if (!replace && index < offset) continue;
    const row = node("tr");
    row.dataset.runId = run.id;

    const dateCell = node("td");
    dateCell.append(node("span", "date-main", run.start_ping_received ? formatDate(run.started_at) : "시작 핑 없음"));
    dateCell.append(node("span", "date-sub", formatDuration(run.duration_ms, run.status === "running")));

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
    ["시작", run.start_ping_received ? formatDate(run.started_at) : "시작 핑 없음"],
    ["종료", formatDate(run.finished_at)],
    ["소요 시간", formatDuration(run.duration_ms, run.status === "running")],
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
document.querySelector("#close-ping-dialog").addEventListener("click", () => document.querySelector("#ping-url-dialog").close());
document.querySelector("#ping-url-dialog").addEventListener("close", () => {
  document.querySelector("#ping-url-value").textContent = "";
});
document.querySelector("#copy-ping-url").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(document.querySelector("#ping-url-value").textContent);
    showAdminMessage("Ping URL을 클립보드에 복사했습니다.");
  } catch {
    showAdminMessage("브라우저에서 복사를 허용하지 않습니다. 표시된 URL을 직접 복사하세요.", true);
  }
});
document.querySelector("#reload-admin").addEventListener("click", () => loadManagement().catch((error) => showAdminMessage(error.message, true)));
document.querySelector("#job-operation").addEventListener("change", () => renderJobRepositoryFields());
document.querySelector("#cancel-job-edit").addEventListener("click", resetJobForm);
document.querySelector("#cancel-host-edit").addEventListener("click", resetHostForm);
document.querySelector("#cancel-repository-edit").addEventListener("click", resetRepositoryForm);
document.querySelector("#cancel-notification-target-edit").addEventListener("click", resetNotificationTargetForm);
document.querySelector("#notification-provider").addEventListener("change", renderNotificationTargetFields);
for (const link of document.querySelectorAll(".sidebar-nav a")) {
  link.addEventListener("click", () => {
    if (link.hash === "#settings") document.querySelector("#settings").open = true;
  });
}
window.addEventListener("hashchange", () => {
  const activeHash = window.location.hash || "#overview";
  for (const link of document.querySelectorAll(".sidebar-nav a")) {
    if (link.hash === activeHash) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
});
for (const link of document.querySelectorAll(".sidebar-nav a")) {
  if (link.hash === (window.location.hash || "#overview")) link.setAttribute("aria-current", "page");
  else link.removeAttribute("aria-current");
}

document.querySelector("#host-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const editing = state.editingHostId !== null;
    const host = state.adminHosts.find((item) => item.id === state.editingHostId);
    await api(editing ? `/api/v1/admin/hosts/${encodeURIComponent(state.editingHostId)}` : "/api/v1/admin/hosts", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(editing
        ? { display_name: data.get("display_name"), enabled: host ? Boolean(host.enabled) : true }
        : { name: data.get("name"), display_name: data.get("display_name") }),
    });
    resetHostForm();
    await loadManagement();
    showAdminMessage(editing ? "호스트 정보를 수정했습니다." : "호스트를 등록했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
});

document.querySelector("#repository-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const data = new FormData(form);
  try {
    const editing = state.editingRepositoryId !== null;
    const repository = state.adminRepositories.find((item) => item.id === state.editingRepositoryId);
    await api(editing
      ? `/api/v1/admin/repositories/${encodeURIComponent(state.editingRepositoryId)}`
      : "/api/v1/admin/repositories", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(editing
        ? {
          name: data.get("name"),
          backend_type: data.get("backend_type"),
          enabled: repository ? Boolean(repository.enabled) : true,
        }
        : {
          repository_key: data.get("repository_key"),
          name: data.get("name"),
          backend_type: data.get("backend_type"),
        }),
    });
    resetRepositoryForm();
    await loadManagement();
    await loadDashboard();
    showAdminMessage(editing ? "저장소 정보를 수정했습니다." : "저장소를 등록했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
});

document.querySelector("#notification-target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const provider = form.elements.namedItem("provider").value;
  const payload = {
    name: form.elements.namedItem("name").value.trim(),
    provider,
    enabled: form.elements.namedItem("enabled").checked,
  };
  if (provider === "discord") {
    const webhookUrl = form.elements.namedItem("webhook_url").value.trim();
    if (!state.editingNotificationTargetId || webhookUrl) payload.config = { webhook_url: webhookUrl };
  } else {
    const botToken = form.elements.namedItem("bot_token").value.trim();
    const chatId = form.elements.namedItem("chat_id").value.trim();
    if (Boolean(botToken) !== Boolean(chatId)) {
      showAdminMessage("Telegram Bot Token과 Chat ID를 함께 입력하세요.", true);
      return;
    }
    if (!state.editingNotificationTargetId || botToken) payload.config = { bot_token: botToken, chat_id: chatId };
  }
  try {
    const editing = state.editingNotificationTargetId !== null;
    await api(editing
      ? `/api/v1/admin/notification-targets/${encodeURIComponent(state.editingNotificationTargetId)}`
      : "/api/v1/admin/notification-targets", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify(payload),
    });
    resetNotificationTargetForm();
    await loadManagement();
    showAdminMessage(editing ? "알림 대상 설정을 수정했습니다." : "알림 대상을 등록했습니다.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
});

document.querySelector("#job-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  try {
    const payload = jobFormPayload(form);
    const editing = state.editingJobId !== null;
    const result = await api(
      editing ? `/api/v1/admin/jobs/${encodeURIComponent(state.editingJobId)}` : "/api/v1/admin/jobs",
      { method: editing ? "PUT" : "POST", body: JSON.stringify(payload) },
    );
    resetJobForm();
    await loadManagement();
    await loadDashboard();
    if (result.ping_url) showPingUrl(result.ping_url);
    showAdminMessage(editing ? "작업 설정을 저장했습니다." : "작업을 등록했습니다. 생성된 Ping URL을 백업 호스트에 안전하게 저장하세요.");
  } catch (error) {
    showAdminMessage(error.message, true);
  }
});

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
loadManagement().catch((error) => showAdminMessage(error.message, true));
