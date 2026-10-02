"use strict";
const state = { version: 0, settings: null, device: null, page: "overview", sessions: [], selected: null, sessionCursor: null, historyCursor: null, recordCursor: null, messages: [], caps: {}, stream: null, paused: true, busy: new Set(), pending: null };
const labels = { queued: "已入队，尚未确认执行", accepted: "来源已接受", failed: "提交失败", delivery_unknown: "结果待确认，请刷新核查", received: "已接收", dispatching: "提交中", running: "执行中", unknown: "状态未知", waiting_external_approval: "等待 Telegram 审批" };
const reads = new Map();

/** Resolve a fixed application element. */
function el(id) { return document.getElementById(id); }
/** Create text-only nodes for source-derived content. */
function node(tag, text, className = "") { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; }
/** Show a transient human-readable status. */
function notice(text) { el("notice").textContent = text; }
/** Drop sensitive render state before applying a new display policy. */
function clearSensitive() {
  for (const id of ["messages", "session-items", "recent-sessions", "record-items", "log-items", "device-items", "status-cards", "create-project", "create-model"]) el(id).replaceChildren();
  el("session-title").textContent = "会话"; el("session-meta").textContent = "";
  state.messages = []; state.sessions = [];
  if (state.selected) state.selected = { ...state.selected, title: "会话" };
}
/** Read the double-submit cookie; keep it only in the current request. */
function csrf() { return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("sea_csrf="))?.slice(9) ?? ""; }
/** Make a version-aware same-origin API request without persistent client storage. */
async function requestApi(path, method = "GET", body) {
  const response = await fetch(path, { method, credentials: "same-origin", cache: "no-store", headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-Sea-Bridge-CSRF": csrf() } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const payload = await response.json(); const version = Number(response.headers.get("X-Sea-Bridge-Settings-Version") ?? state.version);
  if (version < state.version) throw new Error("设置已变化，正在刷新");
  if (version > state.version) { clearSensitive(); state.version = version; }
  if (response.status === 401 && path !== "/api/auth/pair") { showPairing(); throw new Error("设备登录已失效，请重新配对"); }
  if (method === "GET" && state.paused && !["/api/auth/session", "/api/settings"].includes(path.split("?")[0])) throw new Error("连接尚未重新确认设置");
  if (!response.ok) { const error = new Error(({ pair_failed: "配对未成功，检查配对码或稍后重试", csrf_denied: "登录校验失败，请刷新页面", settings_conflict: "设置已被其他设备修改，请刷新", operation_conflict: "请求内容与原记录不一致", body_too_large: "消息过长", source_unavailable: "来源暂不可用", operation_not_received: "未找到提交记录" })[payload.data?.errorCode] ?? "请求失败，请刷新核查"); error.code = payload.data?.errorCode; throw error; }
  return payload.data;
}
/** Coalesce identical in-flight reads across polling, controls and reconnect handlers. */
async function api(path, method = "GET", body) {
  if (method !== "GET") return requestApi(path, method, body);
  if (reads.has(path)) return reads.get(path);
  const pending = requestApi(path); reads.set(path, pending);
  try { return await pending; } finally { reads.delete(path); }
}
/** Prevent repeated work for one UI action and keep errors visible. */
async function run(key, work) {
  if (state.busy.has(key)) return; state.busy.add(key);
  try { await work(); } catch (error) { notice(error.message || "操作失败"); } finally { state.busy.delete(key); }
}
/** Hide all authenticated content and stop its event connection. */
function showPairing() { state.stream?.close(); state.stream = null; state.paused = true; clearSensitive(); el("console").hidden = true; el("pairing").hidden = false; el("create-dialog").close(); }
/** Revalidate settings before any sensitive display resumes. */
async function bootstrap() {
  const session = await api("/api/auth/session"); state.device = session.device; state.settings = session.settings;
  state.version = Math.max(state.version, session.settings.version); el("pairing").hidden = true; el("console").hidden = false;
  if (!state.stream) connectEvents();
}
/** Subscribe only to control events and clear display while the stream is disconnected. */
function connectEvents() {
  const stream = new EventSource("/api/events"); state.stream = stream;
  stream.onopen = () => run("reconnect", async () => { await bootstrap(); state.paused = false; notice(""); await refresh(); });
  stream.onerror = () => { state.paused = true; clearSensitive(); notice("连接暂时中断，正在重新确认设置"); };
  stream.addEventListener("session_revoked", () => { showPairing(); notice("设备已被撤销，请重新配对"); });
  stream.addEventListener("settings_version", (event) => {
    const version = JSON.parse(event.data).version;
    if (version > state.version) { state.version = version; clearSensitive(); run("settings-sync", async () => { await bootstrap(); if (!state.paused) await refresh(); }); }
  });
}
/** Switch views using fixed IDs and load the corresponding data. */
async function showPage(page) {
  state.page = page;
  for (const name of ["overview", "sessions", "records", "settings"]) el(name).hidden = name !== page;
  document.querySelectorAll("nav button").forEach((button) => button.classList.toggle("active", button.dataset.page === page));
  await refresh();
}
/** Refresh the active page only after authenticated settings validation. */
async function refresh() {
  if (state.paused || document.hidden) return;
  if (state.page === "overview") { await loadStatus(); await loadSessions(false); }
  if (state.page === "sessions") { await loadSessions(false); if (state.selected) await loadHistory(false); }
  if (state.page === "records") await loadRecords(false);
  if (state.page === "settings") await loadSettings();
}
/** Render evidence-based source summaries without treating missing evidence as healthy. */
async function loadStatus() {
  const status = await api("/api/status"); const container = el("status-cards"); container.replaceChildren();
  for (const name of ["codex", "dsh"]) { const source = status.sources?.[name]; const card = node("div", "", "status-card"); card.append(node("h2", name === "codex" ? "Codex" : "dsh"), node("p", source?.state === "limited" ? "可读取 · 能力以实际接口为准" : "未就绪 / 暂不可用")); container.append(card); }
  const card = node("div", "", "status-card"); card.append(node("h2", "Telegram"), node("p", status.telegram.pollFailed ? "最近接收失败" : status.telegram.lastPollSuccessAt ? "最近接收正常" : "尚无接收证据")); container.append(card);
}
/** Load a bounded session page, preserving target identity and current draft. */
async function loadSessions(more) {
  const params = new URLSearchParams({ source: el("source-filter").value, q: el("session-search").value, limit: "30" });
  if (more && state.sessionCursor) params.set("cursor", state.sessionCursor);
  const result = await api("/api/sessions?" + params); state.caps = result.capabilities;
  if (params.get("source") !== el("source-filter").value || params.get("q") !== el("session-search").value) return;
  state.sessions = more ? [...state.sessions, ...result.items] : result.items; state.sessionCursor = result.cursor;
  el("more-sessions").hidden = !result.cursor;
  for (const target of ["session-items", "recent-sessions"]) {
    const container = el(target); container.replaceChildren();
    for (const session of state.sessions.slice(0, target === "recent-sessions" ? 6 : state.sessions.length)) {
      const button = node("button", "", "session-row"); button.type = "button";
      button.append(node("span", session.title), node("small", `${session.source} · ${labels[session.state] ?? "未知"}`, "muted"));
      button.onclick = () => run("select", async () => { state.selected = session; state.messages = []; await showPage("sessions"); el("sessions").classList.add("detail-open"); });
      container.append(button);
    }
    if (!container.childElementCount) container.append(node("p", result.partial ? "部分来源暂不可用" : "暂无会话", "muted"));
  }
  if (state.selected) {
    const live = state.sessions.find((item) => item.id === state.selected.id && item.source === state.selected.source);
    if (live) state.selected = live;
    el("session-title").textContent = state.selected.title; el("session-meta").textContent = `${state.selected.source} · ${labels[state.selected.state] ?? "未知"}`;
    el("send-button").disabled = !state.selected.sendEnabled || Boolean(state.pending);
  }
}
/** Read final replies and verified user text; preserve scroll during periodic refresh. */
async function loadHistory(older) {
  const session = state.selected; if (!session) return;
  const params = new URLSearchParams({ limit: "30" }); if (older && state.historyCursor) params.set("cursor", state.historyCursor);
  const result = await api(`/api/sessions/${session.source}/${encodeURIComponent(session.id)}/history?${params}`);
  if (state.selected?.id !== session.id || state.selected?.source !== session.source) return;
  state.messages = older ? [...result.messages, ...state.messages] : result.messages;
  state.messages = [...new Map(state.messages.map((message) => [message.id, message])).values()]; state.historyCursor = result.cursor;
  el("more-history").hidden = !result.cursor;
  const container = el("messages"); const scroll = container.scrollTop; container.replaceChildren();
  for (const message of state.messages) { const item = node("div", "", "message " + message.role); item.append(node("small", message.role === "user" ? "用户" : "助手 · 最终回复", "muted"), node("pre", message.text)); container.append(item); }
  if (!state.messages.length) container.append(node("p", "暂无可读取消息", "muted"));
  container.scrollTop = scroll;
}
/** Render filtered bridge operations and structured logs as plain text. */
async function loadRecords(more) {
  const params = new URLSearchParams({ source: el("record-source").value, sessionId: el("record-session").value, status: el("record-state").value });
  for (const name of ["from", "to"]) if (el("record-" + name).value) params.set(name, String(new Date(el("record-" + name).value).getTime()));
  if (more && state.recordCursor) params.set("cursor", state.recordCursor);
  const result = await api("/api/operations?" + params); if (!more) el("record-items").replaceChildren();
  for (const item of result.items) el("record-items").append(node("div", `${new Date(item.createdAt).toLocaleString()} · ${item.transport} → ${item.source} · ${labels[item.state] ?? item.state}\n${item.sessionId ?? ""} ${item.errorCode ?? ""}`, "record-row"));
  state.recordCursor = result.cursor; el("more-records").hidden = !result.cursor;
  const logs = await api("/api/logs"); el("log-items").replaceChildren();
  for (const item of logs.items) el("log-items").append(node("pre", `${new Date(item.createdAt).toLocaleString()} ${item.event} ${item.fields}`, "record-row"));
}
/** Display global policy and revocable device metadata. */
async function loadSettings() {
  state.settings = await api("/api/settings"); el("redaction-enabled").checked = state.settings.redactionEnabled;
  const devices = await api("/api/devices"); el("device-items").replaceChildren();
  for (const device of devices.items) {
    const row = node("div", "", "device-row"); row.append(node("span", `${device.name}${device.id === devices.currentDeviceId ? "（当前设备）" : ""}\n配对：${new Date(device.pairedAt).toLocaleString()} · 活跃：${new Date(device.lastActiveAt).toLocaleString()}`));
    const button = node("button", device.revokedAt ? "已撤销" : "撤销", "quiet"); button.disabled = Boolean(device.revokedAt);
    button.onclick = () => run("revoke", async () => { await api("/api/devices/" + device.id, "DELETE"); if (device.id === devices.currentDeviceId) showPairing(); else await loadSettings(); }); row.append(button); el("device-items").append(row);
  }
}
/** Discover source-specific catalogs without storing a global default model. */
async function loadCatalogs() {
  const source = el("create-source").value; el("create-submit").disabled = true;
  el("create-project").replaceChildren(); el("create-model").replaceChildren(node("option", "使用来源默认模型")); el("create-model").firstChild.value = "";
  const projects = await api(`/api/sources/${source}/projects`);
  for (const project of projects.items) { const option = node("option", project.name); option.value = project.id; el("create-project").append(option); }
  try { const models = await api(`/api/sources/${source}/models`); for (const model of models.items) { const option = node("option", model.name); option.value = model.id; el("create-model").append(option); } }
  catch { el("create-hint").textContent = "模型目录不可用，可使用来源默认模型。"; }
  await loadSessions(false); const allowed = state.caps[source]?.createEnabled;
  el("create-submit").disabled = !allowed || !projects.items.length;
  el("create-hint").textContent = allowed ? "新会话的审批继续通过 Telegram 处理（如来源需要）。" : "此来源当前不支持新建会话。";
}
/** Show a write outcome without treating submission acceptance as task completion. */
function showOperation(operation) { el("operation-status").textContent = `${labels[operation.state] ?? operation.state}${operation.errorCode ? " · " + operation.errorCode : ""}`; el("reconcile").hidden = !state.pending; el("create-reconcile").hidden = !state.pending; if (el("create-dialog").open) el("create-hint").textContent = labels[operation.state] ?? operation.state; notice(labels[operation.state] ?? operation.state); }
/** Submit once with a stable UUID; ambiguous transport leaves only manual reconciliation. */
async function submitWrite(create) {
  const session = state.selected; if (!create && !session) return;
  if (state.pending) { notice("已有提交待确认，请先刷新核查"); return; }
  const operationId = crypto.randomUUID(); const source = create ? el("create-source").value : session.source;
  const body = create ? { operationId, source, projectId: el("create-project").value, modelId: el("create-model").value || null, prompt: el("create-prompt").value } : { operationId, prompt: el("prompt").value };
  state.pending = { operationId }; el(create ? "create-submit" : "send-button").disabled = true;
  try {
    const operation = await api(create ? "/api/sessions" : `/api/sessions/${source}/${encodeURIComponent(session.id)}/messages`, "POST", body);
    if (operation.state !== "delivery_unknown" && operation.state !== "dispatching") state.pending = null;
    if (["accepted", "queued"].includes(operation.state)) {
      el(create ? "create-prompt" : "prompt").value = "";
      if (create) { el("create-dialog").close(); state.selected = { id: operation.sessionId, source, title: "新会话", state: "unknown", sendEnabled: false }; await showPage("sessions"); el("sessions").classList.add("detail-open"); }
    }
    showOperation(operation); await refresh();
  } catch { notice("提交结果待确认，请刷新核查；不会自动重发。"); el("reconcile").hidden = false; el("create-reconcile").hidden = false; }
  finally { if (create && !state.pending) el("create-submit").disabled = !state.caps[source]?.createEnabled; }
}
/** Reconcile only the recorded operation; no branch resubmits its source write. */
async function reconcilePending() {
  if (!state.pending) return;
  try {
    const operation = await api("/api/operations/" + state.pending.operationId);
    if (!["dispatching", "delivery_unknown", "received"].includes(operation.state)) state.pending = null;
    showOperation(operation);
  } catch (error) {
    if (error.code !== "operation_not_received") throw error;
    state.pending = null; el("reconcile").hidden = true; el("create-reconcile").hidden = true;
    notice("未找到提交记录。请核对任务后再手动提交。");
  }
  if (el("create-dialog").open && !state.pending) el("create-submit").disabled = !state.caps[el("create-source").value]?.createEnabled;
  await refresh();
}

document.querySelectorAll("nav button").forEach((button) => { button.onclick = () => run("page", () => showPage(button.dataset.page)); });
el("pair-form").onsubmit = (event) => { event.preventDefault(); run("pair", async () => { await api("/api/auth/pair", "POST", { code: el("pair-code").value, name: el("device-name").value || null }); el("pair-code").value = ""; await bootstrap(); }); };
el("logout").onclick = () => run("logout", async () => { await api("/api/auth/logout", "POST"); showPairing(); });
el("refresh-status").onclick = () => run("refresh", refresh);
el("source-filter").onchange = () => run("sessions", () => loadSessions(false));
let searchTimer;
el("session-search").oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => run("sessions", () => loadSessions(false)), 300); };
el("more-sessions").onclick = () => run("sessions", () => loadSessions(true));
el("more-history").onclick = () => run("history", () => loadHistory(true));
el("back-to-list").onclick = () => el("sessions").classList.remove("detail-open");
el("new-session").onclick = () => run("catalog", async () => { el("create-dialog").showModal(); await loadCatalogs(); });
el("close-create").onclick = () => el("create-dialog").close();
el("create-source").onchange = () => run("catalog", loadCatalogs);
el("create-form").onsubmit = (event) => { event.preventDefault(); run("write", () => submitWrite(true)); };
el("send-form").onsubmit = (event) => { event.preventDefault(); run("write", () => submitWrite(false)); };
el("record-filter").onsubmit = (event) => { event.preventDefault(); run("records", () => loadRecords(false)); };
el("more-records").onclick = () => run("records", () => loadRecords(true));
el("redaction-form").onsubmit = (event) => { event.preventDefault(); run("settings", async () => { const enabled = el("redaction-enabled").checked; await api("/api/settings/redaction", "PUT", { enabled, expectedVersion: state.settings.version }); await loadSettings(); }); };
el("reconcile").onclick = () => run("reconcile", reconcilePending);
el("create-reconcile").onclick = () => run("reconcile", reconcilePending);
document.addEventListener("visibilitychange", () => { if (document.hidden) { state.paused = true; clearSensitive(); } else run("resume", async () => { await bootstrap(); state.paused = false; await refresh(); }); });
window.addEventListener("pageshow", () => run("resume", async () => { await bootstrap(); if (state.stream?.readyState === EventSource.OPEN) { state.paused = false; await refresh(); } }));
setInterval(() => run("poll", refresh), 3000);
run("startup", async () => { await bootstrap(); });
