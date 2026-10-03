import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("an in-flight sensitive response cannot repopulate the page after SSE disconnect", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  let resolveFetch: (response: Response) => void = () => { throw new Error("request not started"); };
  const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
  const nodes = new Map<string, { textContent: string; removeAttribute: (name: string) => void; replaceChildren: () => void }>();
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ state, api, clearSensitive })", {
    document: { cookie: "", getElementById(id: string) { let value = nodes.get(id); if (!value) { value = { textContent: "", removeAttribute(_name: string) {}, replaceChildren() {} }; nodes.set(id, value); } return value; } },
    fetch: () => pending, URLSearchParams,
  }) as { state: { version: number; paused: boolean }; api: (path: string) => Promise<unknown>; clearSensitive: () => void };
  harness.state.version = 1; harness.state.paused = false;
  const response = harness.api("/api/sessions");
  harness.state.paused = true; harness.clearSensitive();
  resolveFetch(Response.json({ data: { items: [{ title: "private fixture" }] } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await expect(response).rejects.toThrow("连接尚未重新确认设置");
});

test("empty proxy responses surface a generic service-unavailable state", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ api })", {
    document: { cookie: "" }, fetch: async () => new Response("", { status: 503 }), URLSearchParams,
  }) as { api: (path: string, method: string, body: unknown) => Promise<unknown> };
  await expect(harness.api("/api/auth/pair", "POST", { code: "fixture" })).rejects.toThrow("服务暂不可达");
});

test("request timeout is bounded and does not diagnose a specific tunnel or plugin", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ requestApi })", {
    document: { cookie: "" }, URLSearchParams, AbortController,
    setTimeout: (fn: () => void) => { fn(); return 1; }, clearTimeout() {},
    fetch: async (_path: string, options: { signal?: AbortSignal }) => {
      if (options.signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      throw new Error("unexpected");
    },
  }) as { requestApi: (path: string) => Promise<unknown> };
  try { await harness.requestApi("/api/auth/session"); throw new Error("expected timeout"); }
  catch (error: unknown) { if (!error || typeof error !== "object" || !("code" in error) || !("message" in error)) throw error; expect(error.code).toBe("network_timeout"); expect(error.message).toBe("服务响应超时"); expect(error.message).not.toContain("Shadowrocket"); }
});

test("disconnect retains the loaded conversation read-only and preserves ambiguous writes", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const nodes = new Map<string, { id: string; hidden: boolean; textContent: string; open: boolean; disabled: boolean; className: string; value: string; scrollTop: number; removeAttribute: (name: string) => void; replaceChildren: () => void; close: () => void }>(); const delays: number[] = []; const cleared: string[] = [];
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: true, textContent: "", open: false, disabled: false, className: "", value: "", scrollTop: 0, removeAttribute(_name: string) {}, replaceChildren() { cleared.push(id); }, close() { this.open = false; } });
    const result = nodes.get(id); if (!result) throw new Error("fixture missing"); return result;
  };
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ state, enterDisconnected, clearSensitive })", {
    document: { hidden: false, cookie: "", getElementById: node },
    setTimeout: (_fn: () => void, delay: number) => { delays.push(delay); return 17; }, clearTimeout() {},
  }) as { clearSensitive: () => void; state: { messages: unknown[]; sessions: unknown[]; selected: { title: string; sendEnabled: boolean } | null; paused: boolean; pending: unknown; stream: { close: () => void } | null }; enterDisconnected: () => void };
  node("console").hidden = false;
  let closed = 0; harness.state.stream = { close: () => { closed++; } }; harness.state.pending = { operationId: "op" };
  harness.state.messages = [{ id: "loaded" }]; harness.state.sessions = [{ id: "session" }];
  harness.state.selected = { title: "Loaded conversation", sendEnabled: true };
  node("overview-session-count").textContent = "12+"; node("overview-running-count").textContent = "2";
  node("create-dialog").open = true; node("prompt").value = "unsent draft"; node("create-prompt").value = "new task draft";
  node("messages").scrollTop = 160; node("create-project").value = "chosen-project";
  harness.enterDisconnected();
  expect(node("create-dialog").open).toBe(true);
  expect(node("prompt").value).toBe("unsent draft"); expect(node("create-prompt").value).toBe("new task draft");
  expect(node("messages").scrollTop).toBe(160); expect(node("create-project").value).toBe("chosen-project");
  expect(node("create-retry").hidden).toBe(false); expect(node("create-submit").disabled).toBe(true);
  for (const id of ["record-items", "log-items", "device-items", "create-project", "create-model"]) expect(cleared).not.toContain(id);
  expect(node("overview-session-count").textContent).toBe("12+");
  expect(node("overview-running-count").textContent).toBe("2");
  expect(cleared).not.toContain("status-cards"); expect(cleared).not.toContain("recent-sessions");
  expect(node("overview-freshness").hidden).toBe(false);
  expect(harness.state.messages).toHaveLength(1); expect(harness.state.sessions).toHaveLength(1);
  expect(harness.state.selected?.title).toBe("Loaded conversation");
  expect(harness.state.selected?.sendEnabled).toBe(false);
  expect(cleared).not.toContain("messages"); expect(cleared).not.toContain("session-items"); expect(cleared).not.toContain("log-items");
  expect(harness.state.paused).toBe(true); expect(closed).toBe(1);
  expect(node("notice-bar").hidden).toBe(false);
  expect(node("notice-bar").className).toContain("notice-connection");
  expect(node("notice-text").textContent).toContain("不会自动重发");
  expect(node("notice-retry").hidden).toBe(false);
  expect(node("notice-close").hidden).toBe(true);
  expect(node("send-button").disabled).toBe(true);
  expect(node("operation-status").textContent).toContain("结果待确认");
  expect(delays).toEqual([1000]);
  harness.clearSensitive();
  for (const id of ["status-cards", "recent-sessions", "record-items", "log-items", "device-items", "create-project", "create-model", "messages"]) expect(cleared).toContain(id);
  expect(node("overview-session-count").textContent).toBe("—");
});

test("successful recovery reconciles an ambiguous operation instead of replaying its write", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const calls = { reconcile: 0, refresh: 0 }; const nodes = new Map<string, { hidden: boolean; textContent: string }>();
  const harness = runInNewContext(script.slice(0, boundary) + `
validateConnection = async () => {};
reconcilePending = async () => { calls.reconcile++; };
refresh = async () => { calls.refresh++; };
({ state, finishRecovery })`, {
    EventSource: { OPEN: 1 }, calls, document: { cookie: "", getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "" }); return nodes.get(id); } },
  }) as { state: { pending: unknown; paused: boolean; stream: { readyState: number } }; finishRecovery: () => Promise<void> };
  harness.state.pending = { operationId: "op" }; harness.state.stream = { readyState: 1 };
  await harness.finishRecovery();
  expect(calls).toEqual({ reconcile: 1, refresh: 0 });
  expect(harness.state.paused).toBe(false);
});

test("mobile pairing explicitly validates digits and always releases its button", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("async function pairDevice()");
  const end = script.indexOf('\nel("pair-submit").onclick', start);
  if (start < 0 || end < 0) throw new Error("pair handler missing");
  const nodes: Record<string, { value: string; disabled: boolean }> = { "pair-code": { value: "bad", disabled: false }, "pair-submit": { value: "", disabled: false }, "device-name": { value: "", disabled: false } };
  let calls = 0; const notices: string[] = [];
  const pair = runInNewContext(script.slice(start, end) + "\npairDevice", { el: (id: string) => nodes[id], notice: (text: string) => notices.push(text), api: async () => { calls++; throw new Error("fixture transport failure"); } }) as () => Promise<void>;
  await pair(); expect(calls).toBe(0); expect(notices).toContain("请输入 8 位数字配对码");
  nodes["pair-code"]!.value = " 12345678 ";
  await expect(pair()).rejects.toThrow("fixture transport failure");
  expect(calls).toBe(1); expect(notices).toContain("正在配对…"); expect(nodes["pair-submit"]!.disabled).toBe(false);
});

test("request timeout remains active while reading the response body", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let expired = () => {}; let canceled = false;
  const ui = runInNewContext(script.slice(0, end) + "\n({ requestApi })", {
    document: { cookie: "" }, AbortController,
    setTimeout: (callback: () => void) => { expired = callback; return 1; },
    clearTimeout: () => { canceled = true; },
    fetch: async (_path: string, options: { signal: AbortSignal }) => ({ status: 200, json: async () => {
      if (canceled) throw new Error("timer canceled before body read");
      expired();
      if (options.signal.aborted) throw Object.assign(new Error("body aborted"), { name: "AbortError" });
      return {};
    } }),
  }) as { requestApi: (path: string) => Promise<unknown> };
  await expect(ui.requestApi("/api/auth/session")).rejects.toThrow("服务响应超时");
  expect(canceled).toBe(true);
});

test("a recovery response cannot unpause content after its SSE connection is lost", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let complete = () => {};
  const validation = new Promise<void>((resolve) => { complete = resolve; });
  const ui = runInNewContext(script.slice(0, end) + '\nvalidateConnection = () => validation; refresh = async () => {}; ({ state, finishRecovery })', {
    validation, EventSource: { OPEN: 1 }, document: { getElementById: () => ({ hidden: false, textContent: "" }) },
  }) as { state: { paused: boolean; stream: { readyState: number } | null }; finishRecovery: () => Promise<void> };
  ui.state.stream = { readyState: 1 };
  const recovery = ui.finishRecovery();
  ui.state.stream = null; ui.state.paused = true;
  complete(); await recovery;
  expect(ui.state.paused).toBe(true);
});

test("backgrounding an unfinished SSE recovery releases its guard and resumes retry", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const start = script.indexOf('document.addEventListener("visibilitychange", () => {');
  const end = script.indexOf('\nwindow.addEventListener("pageshow"', start);
  let listener: () => void = () => { throw new Error("listener missing"); };
  const nodes = new Map<string, { hidden: boolean; textContent: string; disabled: boolean; className: string; replaceChildren: () => void }>();
  const document = { hidden: true, getElementById(id: string) {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: "", disabled: false, className: "", replaceChildren() {} });
    return nodes.get(id);
  }, addEventListener(_name: string, fn: () => void) { listener = fn; } };
  const delays: number[] = [];
  const ui = runInNewContext(script.slice(0, boundary) + '\n' + script.slice(start, end) + '\n({ state, recoverConnection })', {
    document, setTimeout: (_fn: () => void, delay: number) => { delays.push(delay); return delays.length; }, clearTimeout() {},
  }) as { state: { recovering: boolean; paused: boolean; stream: { close: () => void } | null }; recoverConnection: () => Promise<void> };
  const consoleNode = document.getElementById("console"); if (!consoleNode) throw new Error("console fixture missing"); consoleNode.hidden = false;
  let closed = 0;
  ui.state.recovering = true; ui.state.stream = { close: () => { closed++; } };
  listener();
  expect(ui.state.recovering).toBe(false); expect(closed).toBe(1);
  expect(nodes.get("notice-bar")?.hidden).toBe(false);
  expect(nodes.get("notice-close")?.hidden).toBe(true);
  document.hidden = false; listener();
  expect(delays).toEqual([0]);
  for (let attempt = 0; attempt < 10; attempt++) await ui.recoverConnection();
  expect(delays.slice(-3)).toEqual([30000, 30000, 30000]);
  expect(nodes.get("notice-bar")?.hidden).toBe(false);
  expect(nodes.get("notice-bar")?.className).toContain("notice-connection");
});

test("catalog failure keeps the previously loaded projects and models", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const cleared: string[] = [];
  const ui = runInNewContext(script.slice(0, end) + '\nnode = () => ({}); api = async () => { throw new Error("offline"); }; ({ loadCatalogs })', {
    document: { getElementById: (id: string) => ({ value: "codex", firstChild: { value: "" }, replaceChildren: () => cleared.push(id) }) },
    node: () => ({}),
  }) as { loadCatalogs: () => Promise<void> };
  await expect(ui.loadCatalogs()).rejects.toThrow("offline");
  expect(cleared).toEqual([]);
});
