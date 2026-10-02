"use strict";
const state = { version: 0, settings: null, device: null, page: "overview", sessions: [], selected: null, sessionCursor: null, historyCursor: null, recordCursor: null, messages: [], caps: {}, stream: null, streamTimer: null, reconnectTimer: null, retryAttempt: 0, recovering: false, lastConnectedAt: null, paused: true, busy: new Set(), pending: null, awaitingReply: null, followLatest: false };
const READ_TIMEOUT_MS = 8000;
const WRITE_TIMEOUT_MS = 20000;
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 15000, 30000];
const labels = { queued: "已入队，尚未确认执行", accepted: "来源已接受", failed: "提交失败", delivery_unknown: "结果待确认，请刷新核查", received: "已接收", dispatching: "提交中", running: "执行中", unknown: "状态未知", waiting_external_approval: "等待 Telegram 审批" };
const reads = new Map();
let historyTools;

/** Generate an RFC 4122 UUID with secure randomness on HTTP Tailnet pages too. */
function operationUuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Allow web links and HTTPS images, never executable schemes or URL credentials. */
function safeMessageUrl(value, image) {
  try {
    const url = new URL(value, location.origin);
    if (url.username || url.password || !["http:", "https:"].includes(url.protocol)) return null;
    if (image && url.protocol !== "https:" && url.origin !== location.origin) return null;
    return url.href;
  } catch { return null; }
}
/** Render inline Markdown using text nodes; source HTML is never interpreted. */
function appendInline(parent, text, depth = 0) {
  if (depth > 3) { parent.append(document.createTextNode(text)); return; }
  const pattern = /(!?\[([^\]\n]*)\]\(([^\s)]+)\)|`([^`\n]+)`|\*\*([^*\n]+)\*\*|\*([^*\n]+)\*)/g;
  let offset = 0;
  for (const match of text.matchAll(pattern)) {
    parent.append(document.createTextNode(text.slice(offset, match.index)));
    if (match[2] !== undefined) {
      const image = match[1].startsWith("!"); const href = safeMessageUrl(match[3], image);
      if (!href) parent.append(document.createTextNode(match[0]));
      else if (image) {
        const box = node("span", "", "markdown-image"); const button = node("button", `加载图片：${match[2] || "图片"}`, "quiet"); button.type = "button";
        button.onclick = () => {
          const img = document.createElement("img"); img.alt = match[2]; img.referrerPolicy = "no-referrer"; img.loading = "lazy";
          img.onerror = () => { box.replaceChildren(node("span", "图片无法加载", "muted")); };
          img.src = href; box.replaceChildren(img);
        };
        box.append(button); parent.append(box);
      } else {
        const link = node("a", match[2]); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; parent.append(link);
      }
    } else {
      const element = node(match[4] !== undefined ? "code" : match[5] !== undefined ? "strong" : "em", "");
      if (match[4] !== undefined) element.textContent = match[4]; else appendInline(element, match[5] ?? match[6], depth + 1);
      parent.append(element);
    }
    offset = match.index + match[0].length;
  }
  parent.append(document.createTextNode(text.slice(offset)));
}
/** Render bounded Markdown blocks: headings, lists, quotes, tables and fenced code. */
function renderMarkdown(text) {
  const root = node("div", "", "markdown"); const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*```/.test(line)) {
      const language = line.trim().slice(3); const code = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      const pre = node("pre", "", "code-block"); if (language) pre.append(node("small", language, "muted")); pre.append(node("code", code.join("\n"))); root.append(pre); continue;
    }
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      const wrapper = node("div", "", "table-scroll"); const table = node("table", "");
      /** Build a table row using safe inline nodes. */
      const row = (value, tag) => { const tr = node("tr", ""); for (const cell of value.trim().replace(/^\||\|$/g, "").split("|")) { const td = node(tag, ""); appendInline(td, cell.trim()); tr.append(td); } return tr; };
      table.append(row(line, "th")); i++;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) table.append(row(lines[++i], "td"));
      wrapper.append(table); root.append(wrapper); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const list = /^\s*(?:[-*+] |\d+\. )(.+)$/.exec(line);
    if (list) {
      const ordered = /^\s*\d+\./.test(line); const container = node(ordered ? "ol" : "ul", "");
      let value = list[1];
      while (true) { const li = node("li", ""); appendInline(li, value); container.append(li); const next = (ordered ? /^\s*\d+\. (.+)$/ : /^\s*[-*+] (.+)$/).exec(lines[i + 1] ?? ""); if (!next) break; value = next[1]; i++; }
      root.append(container); continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { root.append(node("hr", "")); continue; }
    const block = node(heading ? `h${heading[1].length}` : line.startsWith("> ") ? "blockquote" : "p", "");
    appendInline(block, heading ? heading[2] : line.startsWith("> ") ? line.slice(2) : line); root.append(block);
  }
  return root;
}

/** Resolve a fixed application element. */
function el(id) { return document.getElementById(id); }
/** Create text-only nodes for source-derived content. */
function node(tag, text, className = "") { const value = document.createElement(tag); value.textContent = text; value.className = className; return value; }
/** Show a transient human-readable status. */
function notice(text) { el("notice").textContent = text; }
/** Create a typed client error without exposing lower-level transport details. */
function clientError(code, message) { const error = new Error(message); error.code = code; return error; }
/** Classify only failures that require connection recovery. */
function isTransportError(error) { return ["network_unavailable", "network_timeout", "transport_invalid_response"].includes(error?.code); }
/** Cancel the single scheduled recovery attempt. */
function cancelReconnectTimer() { if (state.reconnectTimer !== null && typeof clearTimeout === "function") clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
/** Cancel the SSE opening deadline. */
function cancelStreamTimer() { if (state.streamTimer !== null && typeof clearTimeout === "function") clearTimeout(state.streamTimer); state.streamTimer = null; }
/** Keep the application shell visible while all sensitive render state is hidden. */
function showConnectionPanel(detail = "连接已中断，敏感内容已隐藏。") {
  el("connection-title").textContent = "服务暂不可达";
  el("connection-detail").textContent = detail;
  el("connection-panel").hidden = false;
}
/** Clear connection status only after recovery or explicit pairing. */
function hideConnectionPanel() { el("connection-panel").hidden = true; el("connection-retry-state").textContent = ""; }
/** Drop sensitive render state before applying a new display policy. */
function clearSensitive() {
  for (const id of ["session-items", "recent-sessions", "record-items", "log-items", "device-items", "status-cards", "create-project", "create-model"]) el(id).replaceChildren();
  el("session-title").textContent = "会话"; el("session-meta").textContent = "";
  el("messages").replaceChildren(historyTools ?? el("history-tools"));
  state.messages = []; state.sessions = [];
  if (state.selected) state.selected = { ...state.selected, title: "会话" };
}
/** Read the double-submit cookie; keep it only in the current request. */
function csrf() { return document.cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("sea_csrf="))?.slice(9) ?? ""; }
/** Make a version-aware same-origin API request with bounded client-side waiting. */
async function requestApi(path, method = "GET", body) {
  let response; const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutMs = method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS;
  const timeout = controller && typeof setTimeout === "function" ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    response = await fetch(path, { method, credentials: "same-origin", cache: "no-store",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(method !== "GET" ? { "X-Sea-Bridge-CSRF": csrf() } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(controller ? { signal: controller.signal } : {}) });
  } catch (cause) {
    if (timeout !== null && typeof clearTimeout === "function") clearTimeout(timeout);
    throw clientError(cause?.name === "AbortError" ? "network_timeout" : "network_unavailable",
      cause?.name === "AbortError" ? "服务响应超时" : "服务暂不可达");
  }
  let payload;
  try { payload = await response.json(); }
  catch (cause) {
    if (controller?.signal.aborted || cause?.name === "AbortError") throw clientError("network_timeout", "服务响应超时");
    if (response.status >= 500) throw clientError("transport_invalid_response", "服务暂不可达");
    throw clientError("invalid_response", `接口返回异常（HTTP ${response.status}，${response.headers.get("Content-Type") || "未提供内容类型"}）`);
  }
  finally { if (timeout !== null && typeof clearTimeout === "function") clearTimeout(timeout); }
  const version = Number(response.headers.get("X-Sea-Bridge-Settings-Version") ?? state.version);
  if (version < state.version) throw clientError("settings_stale", "设置已变化，正在刷新");
  if (version > state.version) { clearSensitive(); state.version = version; }
  if (response.status === 401 && path !== "/api/auth/pair") { showPairing(); throw clientError("auth_required", "设备登录已失效，请重新配对"); }
  if (method === "GET" && state.paused && !["/api/auth/session", "/api/settings"].includes(path.split("?")[0])) throw clientError("connection_unverified", "连接尚未重新确认设置");
  if (!response.ok) { const error = new Error(({ pair_failed: "配对未成功，检查配对码或稍后重试", csrf_denied: "登录校验失败，请刷新页面", settings_conflict: "设置已被其他设备修改，请刷新", operation_conflict: "请求内容与原记录不一致", body_too_large: "消息过长", invalid_field: "输入不符合要求", invalid_source: "来源参数无效", invalid_operation_id: "请求标识无效", source_unavailable: "来源暂不可用", operation_not_received: "未找到提交记录" })[payload.data?.errorCode] ?? "请求失败，请刷新核查"); error.code = payload.data?.errorCode; throw error; }
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
  try { await work(); }
  catch (error) {
    if (isTransportError(error)) enterDisconnected();
    else if (error?.code !== "auth_required") notice(error?.message || "操作失败");
  } finally { state.busy.delete(key); }
}
/** Stop retry machinery and return to the explicit pairing boundary. */
function showPairing() {
  cancelReconnectTimer(); cancelStreamTimer(); state.retryAttempt = 0; state.recovering = false;
  state.stream?.close(); state.stream = null; state.paused = true; clearSensitive(); hideConnectionPanel();
  el("console").hidden = true; el("pairing").hidden = false; el("create-dialog").close();
}
/** Validate both session and current display policy before restoring sensitive content. */
async function validateConnection() {
  const session = await requestApi("/api/auth/session");
  const settings = await requestApi("/api/settings");
  state.device = session.device; state.settings = settings;
  state.version = Math.max(state.version, session.settings?.version ?? 0, settings.version ?? 0);
  el("pairing").hidden = true; el("console").hidden = false;
}
/** Schedule bounded exponential recovery attempts without replaying writes. */
function scheduleReconnect(immediate = false) {
  if (document.hidden || state.reconnectTimer !== null || typeof setTimeout !== "function") return;
  const delay = immediate ? 0 : RETRY_DELAYS_MS[Math.min(state.retryAttempt, RETRY_DELAYS_MS.length - 1)];
  el("connection-retry-state").textContent = delay === 0 ? "正在重试…" : `${Math.ceil(delay / 1000)} 秒后自动重试`;
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; void recoverConnection(); }, delay);
}
/** Enter a safe disconnected state; keep the shell but remove all sensitive render content. */
function enterDisconnected() {
  const failedRecovery = state.recovering;
  state.paused = true; state.recovering = false; cancelStreamTimer();
  if (failedRecovery) state.retryAttempt++;
  state.stream?.close(); state.stream = null; clearSensitive();
  if (el("create-dialog").open) el("create-dialog").close();
  showConnectionPanel(state.pending ? "连接已中断。发送结果待确认，恢复后会核查原请求，不会自动重发。" : "连接已中断，敏感内容已隐藏。");
  if (state.pending) el("operation-status").textContent = "结果待确认；恢复连接后自动核查";
  scheduleReconnect();
}
/** Complete recovery only after HTTP auth/settings and the SSE control channel are both healthy. */
async function finishRecovery(stream = state.stream) {
  if (!stream || state.stream !== stream || stream.readyState !== EventSource.OPEN || document.hidden) return;
  await validateConnection();
  if (state.stream !== stream || stream.readyState !== EventSource.OPEN || document.hidden) return;
  state.paused = false; state.retryAttempt = 0; state.recovering = false; state.lastConnectedAt = Date.now();
  cancelReconnectTimer(); hideConnectionPanel(); notice("");
  if (state.pending) await reconcilePending();
  else await refresh();
}
/** Revalidate HTTP state, then establish a fresh SSE channel. */
async function recoverConnection() {
  if (document.hidden || state.recovering || !state.paused) return;
  state.recovering = true; cancelReconnectTimer(); el("connection-retry-state").textContent = "正在重试…";
  try {
    await validateConnection();
    state.stream?.close(); state.stream = null; connectEvents();
    el("connection-retry-state").textContent = "服务已响应，正在恢复实时连接…";
  } catch (error) {
    state.recovering = false;
    if (error?.code === "auth_required") return;
    state.retryAttempt++;
    showConnectionPanel();
    scheduleReconnect();
  }
}
/** Initial auth bootstrap reuses the same recovery contract as later reconnects. */
async function bootstrap() {
  await validateConnection();
  if (!state.stream) connectEvents();
}
/** Subscribe only to control events; EventSource failure enters the same bounded recovery path. */
function connectEvents() {
  cancelStreamTimer();
  const stream = new EventSource("/api/events"); state.stream = stream;
  if (typeof setTimeout === "function") state.streamTimer = setTimeout(() => {
    if (state.stream === stream && stream.readyState !== EventSource.OPEN) enterDisconnected();
  }, READ_TIMEOUT_MS);
  stream.onopen = () => {
    if (state.stream !== stream) return;
    cancelStreamTimer();
    run("reconnect", () => finishRecovery(stream));
  };
  stream.onerror = () => { if (state.stream === stream) enterDisconnected(); };
  stream.addEventListener("session_revoked", () => { showPairing(); notice("设备已被撤销，请重新配对"); });
  stream.addEventListener("settings_version", (event) => {
    const version = JSON.parse(event.data).version;
    if (version > state.version) {
      state.version = version; state.paused = true; clearSensitive();
      run("settings-sync", async () => { await validateConnection(); if (state.stream?.readyState === EventSource.OPEN) { state.paused = false; await refresh(); } });
    }
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
      button.onclick = () => run("select", async () => {
        state.selected = session; state.messages = []; state.historyCursor = null; state.followLatest = true;
        el("sessions").classList.add("detail-open"); await showPage("sessions");
      });
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
/** Position the latest rendered message inside the actual message scroller. */
function scrollMessagesToLatest(container) {
  container.scrollTop = container.scrollHeight;
  container.lastElementChild?.scrollIntoView?.({ block: "end", inline: "nearest" });
}
/** Read final replies and verified user text; preserve scroll during periodic refresh. */
async function loadHistory(older) {
  const session = state.selected; if (!session) return;
  const params = new URLSearchParams({ limit: "30" }); if (older && state.historyCursor) params.set("cursor", state.historyCursor);
  const result = await api(`/api/sessions/${session.source}/${encodeURIComponent(session.id)}/history?${params}`);
  if (state.selected?.id !== session.id || state.selected?.source !== session.source) return;
  const hadMessages = state.messages.length > 0;
  state.messages = older ? [...result.messages, ...state.messages] : hadMessages ? [...state.messages, ...result.messages] : result.messages;
  state.messages = [...new Map(state.messages.map((message) => [message.id, message])).values()];
  // Latest polling must not move the "older" boundary forward after the user has paged back.
  if (older || !hadMessages) state.historyCursor = result.cursor;
  el("more-history").hidden = !state.historyCursor;
  const container = el("messages"); const scroll = container.scrollTop; const previousHeight = container.scrollHeight;
  const nearBottom = container.scrollHeight - container.clientHeight - scroll < 100;
  const follow = !older && (!hadMessages || state.followLatest || nearBottom);
  container.replaceChildren(historyTools ?? el("history-tools"));
  for (const message of state.messages) {
    const item = node("div", "", "message " + message.role);
    const time = Number.isFinite(message.createdAt) ? new Date(message.createdAt).toLocaleString("zh-CN") : "时间未知";
    item.append(node("small", `${message.role === "user" ? "用户" : "助手 · 最终回复"} · ${time}`, "message-meta"), renderMarkdown(message.text)); container.append(item);
  }
  if (!state.messages.length) container.append(node("p", "暂无可读取消息", "muted"));
  if (follow) scrollMessagesToLatest(container); else container.scrollTop = older ? scroll + container.scrollHeight - previousHeight : scroll;
  state.followLatest = false;
  if (state.awaitingReply?.sessionId === session.id && state.awaitingReply.source === session.source) {
    const latest = [...state.messages].reverse().find((message) => message.role === "assistant");
    if (latest && latest.id !== state.awaitingReply.baseline) {
      state.awaitingReply = null; el("operation-status").textContent = "发现新的最终回复"; notice("发现新的最终回复");
    }
  }
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
function showOperation(operation) {
  const knownSession = operation.kind === "create" && operation.sessionId ? ` · 已创建会话 ${operation.sessionId}` : "";
  const detail = `${labels[operation.state] ?? operation.state}${operation.errorCode ? " · " + operation.errorCode : ""}${knownSession}`;
  el("operation-status").textContent = detail; el("reconcile").hidden = !state.pending; el("create-reconcile").hidden = !state.pending;
  if (el("create-dialog").open) el("create-hint").textContent = detail; notice(detail);
}
/** Submit once with a stable UUID; ambiguous transport leaves only manual reconciliation. */
async function submitWrite(create) {
  const session = state.selected; if (!create && !session) return;
  if (state.pending) { notice("已有提交待确认，请先刷新核查"); return; }
  const operationId = operationUuid(); const source = create ? el("create-source").value : session.source;
  const body = create ? { operationId, source, projectId: el("create-project").value, modelId: el("create-model").value || null, prompt: el("create-prompt").value } : { operationId, prompt: el("prompt").value };
  state.pending = { operationId }; el(create ? "create-submit" : "send-button").disabled = true;
  try {
    const operation = await api(create ? "/api/sessions" : `/api/sessions/${source}/${encodeURIComponent(session.id)}/messages`, "POST", body);
    if (operation.state !== "delivery_unknown" && operation.state !== "dispatching") state.pending = null;
    if (["accepted", "queued"].includes(operation.state)) {
      state.followLatest = true;
      state.awaitingReply = { sessionId: operation.sessionId ?? session?.id, source, baseline: [...state.messages].reverse().find((message) => message.role === "assistant")?.id ?? null };
      el(create ? "create-prompt" : "prompt").value = "";
      if (create) { el("create-dialog").close(); state.selected = { id: operation.sessionId, source, title: "新会话", state: "unknown", sendEnabled: false }; el("sessions").classList.add("detail-open"); await showPage("sessions"); }
    }
    showOperation(operation); await refresh();
  } catch (error) {
    const definite = new Set(["invalid_field", "invalid_source", "invalid_operation_id", "body_too_large", "source_unavailable", "csrf_denied", "operation_conflict"]);
    if (definite.has(error.code)) {
      state.pending = null; notice(error.message || "提交失败"); el("reconcile").hidden = true; el("create-reconcile").hidden = true; await refresh();
    } else {
      el("operation-status").textContent = "结果待确认；不会自动重发";
      el("reconcile").hidden = false; el("create-reconcile").hidden = false;
      if (isTransportError(error)) enterDisconnected();
      else notice("提交结果待确认，请刷新核查；不会自动重发。");
    }
  }
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


/** Bound the draft to one through three lines without changing the reading position. */
function resizeComposer() {
  const prompt = el("prompt"); const style = getComputedStyle(prompt);
  const messages = el("messages"); const follow = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 100;
  const line = parseFloat(style.lineHeight) || 24;
  const padding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const border = (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  prompt.style.height = "auto";
  prompt.style.height = `${Math.min(line * 3 + padding + border, Math.max(line + padding + border, prompt.scrollHeight + border))}px`;
  if (follow && !state.paused) scrollMessagesToLatest(messages);
}
/** Fit the mobile authenticated shell to the visible screen, including the software keyboard. */
function syncViewport() {
  if (window.innerWidth > 760) return;
  const viewport = window.visualViewport;
  if (viewport && viewport.scale !== 1) return;
  const messages = el("messages"); const follow = messages.scrollHeight - messages.clientHeight - messages.scrollTop < 100;
  document.documentElement.style.setProperty("--app-height", `${viewport?.height ?? window.innerHeight}px`);
  document.documentElement.style.setProperty("--app-top", `${viewport?.offsetTop ?? 0}px`);
  document.documentElement.classList.toggle("keyboard-open", document.activeElement === el("prompt") && window.innerHeight - (viewport?.height ?? window.innerHeight) > 120);
  if (follow && !state.paused) scrollMessagesToLatest(messages);
}

document.querySelectorAll("nav button").forEach((button) => { button.onclick = () => run("page", () => showPage(button.dataset.page)); });
historyTools = el("history-tools");
el("prompt").oninput = resizeComposer;
el("prompt").addEventListener("focus", syncViewport);
el("prompt").addEventListener("blur", syncViewport);
window.visualViewport?.addEventListener("resize", syncViewport);
window.visualViewport?.addEventListener("scroll", syncViewport);
window.addEventListener("resize", syncViewport);
syncViewport();
el("client-version").textContent = "配对诊断版本：pair3";
/** Validate explicitly so mobile native form validation cannot silently block pairing. */
async function pairDevice() {
  const code = el("pair-code").value.trim();
  if (!/^[0-9]{8}$/.test(code)) { notice("请输入 8 位数字配对码"); return; }
  notice("正在配对…"); el("pair-submit").disabled = true;
  try {
    await api("/api/auth/pair", "POST", { code, name: el("device-name").value || null });
    notice("配对已接受，正在确认登录…"); el("pair-code").value = ""; await bootstrap();
  } finally { el("pair-submit").disabled = false; }
}
el("pair-submit").onclick = () => run("pair", pairDevice);
el("pair-form").onsubmit = (event) => { event.preventDefault(); run("pair", pairDevice); };
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
el("connection-retry").onclick = () => {
  if (state.recovering) return;
  cancelReconnectTimer(); scheduleReconnect(true);
};
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    state.paused = true; cancelReconnectTimer(); cancelStreamTimer(); state.stream?.close(); state.stream = null; clearSensitive(); return;
  }
  showConnectionPanel("正在重新确认连接和显示设置…"); scheduleReconnect(true);
});
window.addEventListener("pageshow", () => { if (state.paused) { showConnectionPanel("正在重新确认连接和显示设置…"); scheduleReconnect(true); } });
window.addEventListener("online", () => { if (state.paused) { cancelReconnectTimer(); scheduleReconnect(true); } });
window.addEventListener("offline", () => enterDisconnected());
setInterval(() => run("poll", refresh), 3000);
run("startup", async () => { await bootstrap(); });
