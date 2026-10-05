import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

/** Load browser helpers without event bindings or a real browser session. */
async function helpers(crypto: unknown): Promise<{ operationUuid: () => string; safeMessageUrl: (value: string, image: boolean) => string | null }> {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (end < 0) throw new Error("UI boundary missing");
  return runInNewContext(script.slice(0, end) + "\n({ operationUuid, safeMessageUrl })", { crypto, URL, location: { origin: "http://100.112.22.85:7310" } });
}

test("operation UUID works without secure-context randomUUID and retains UUID v4 bits", async () => {
  const ui = await helpers({ getRandomValues: (bytes: Uint8Array) => { bytes.fill(255); return bytes; } });
  expect(ui.operationUuid()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
});

test("message links and images reject executable, local-file and credential URLs", async () => {
  const ui = await helpers({});
  for (const value of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/test", "https://user:pass@example.test/a"]) {
    expect(ui.safeMessageUrl(value, false)).toBeNull();
    expect(ui.safeMessageUrl(value, true)).toBeNull();
  }
  expect(ui.safeMessageUrl("https://example.test/image.png", true)).toBe("https://example.test/image.png");
  expect(ui.safeMessageUrl("http://example.test/image.png", true)).toBeNull();
});

/** Minimal DOM fixture preserving whether text became markup or an executable element. */
class ElementFixture {
  children: ElementFixture[] = [];
  attributes = new Map<string, string>();
  /** Store accessibility attributes without interpreting markup. */
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  /** Remove a transient accessibility state. */
  removeAttribute(name: string): void { this.attributes.delete(name); if (name === "src") this.src = ""; }
  textContent = "";
  src = "";
  style = { height: "" };
  onclick?: () => void;
  onkeydown?: (event: { key: string; preventDefault(): void }) => void;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  scrollIntoViewCalls = 0;
  hidden = false;
  className = "";
  /** Capture the emitted tag without interpreting HTML. */
  constructor(readonly tag: string) {}
  get lastElementChild(): ElementFixture | null { return this.children.at(-1) ?? null; }
  /** Append only already-constructed nodes. */
  append(...nodes: ElementFixture[]): void { this.children.push(...nodes); }
  /** Replace children after an explicit image-loading click. */
  replaceChildren(...nodes: ElementFixture[]): void { this.children = nodes; }
  scrollIntoView(): void { this.scrollIntoViewCalls++; }
}

/** Flatten the fixture tree for structural security and formatting assertions. */
function flatten(root: ElementFixture): ElementFixture[] { return [root, ...root.children.flatMap(flatten)]; }

test("assistant memory citations disappear from display and copy while examples and raw history remain", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const ui = runInNewContext(script.slice(0, end) + "\n({ messageDisplayText, messageCopyText, renderMarkdown })", {
    document: {
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode(text: string) { const element = new ElementFixture("#text"); element.textContent = text; return element; },
    },
  }) as { messageDisplayText(message: { role: string; text: string }): string; messageCopyText(message: { role: string; text: string }): string; renderMarkdown(text: string): ElementFixture };
  const citation = "<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[fixture]\n</citation_entries>\n<rollout_ids>\nfixture-id\n</rollout_ids>\n</oai-mem-citation>";
  const text = "# 已配置\n\n正文 **保留**\n\n" + citation;
  const message = { role: "assistant", text };
  expect(ui.messageDisplayText(message)).toBe("# 已配置\n\n正文 **保留**");
  expect(ui.messageCopyText(message)).toBe(ui.messageDisplayText(message));
  expect(flatten(ui.renderMarkdown(ui.messageDisplayText(message))).map((node) => node.textContent).join(" ")).not.toContain("MEMORY.md");
  expect(message.text).toBe(text);
  expect(ui.messageDisplayText({ role: "user", text })).toBe(text);
  for (const fence of ["```xml", "~~~xml"]) {
    const example = fence + "\n" + citation + "\n" + fence.slice(0, 3);
    expect(ui.messageDisplayText({ role: "assistant", text: example })).toBe(example);
    expect(ui.messageCopyText({ role: "assistant", text: example })).toBe(example);
  }
  const incomplete = "正文\n<oai-mem-citation>\n不完整引用";
  expect(ui.messageDisplayText({ role: "assistant", text: incomplete })).toBe(incomplete);
  expect(ui.messageDisplayText({ role: "assistant", text: "before\n" + citation + "\nafter\n" + citation })).toBe("before\nafter");
});

test("queued bubbles refresh by identity, preserve queue order and disappear when consumed", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let queued = [{ id: "q2", role: "user", text: "second", createdAt: Date.now(), deliveryState: "queued" }, { id: "q1", role: "user", text: "first", createdAt: Date.now(), deliveryState: "queued" }];
  let unavailable = false; let sessionState = "running";
  const ui = runInNewContext(script.slice(0, end) + "\n({ state, loadHistory })", {
    URL, URLSearchParams, location: { origin: "http://127.0.0.1:7310" },
    fetch: async () => Response.json({ data: { messages: [{ id: "history", role: "user", text: "executed", createdAt: 1 }], queuedMessages: unavailable ? undefined : queued, queueUnavailable: unavailable, sessionState, cursor: null } }),
    document: {
      cookie: "", getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode(text: string) { const node = new ElementFixture("#text"); node.textContent = text; return node; },
    },
  }) as { state: { paused: boolean; selected: { id: string; source: string }; messages: Array<{ id: string; deliveryState?: string }> }; loadHistory(older: boolean): Promise<void> };
  ui.state.paused = false; ui.state.selected = { id: "thread", source: "codex" };
  await ui.loadHistory(false);
  expect(ui.state.messages.map((message) => message.id)).toEqual(["history", "q2", "q1"]);
  expect(nodes.get("session-meta")?.textContent).toBe("Codex · 创建来源未知 · 执行中");
  const root = nodes.get("messages")!;
  expect(flatten(root).filter((node) => node.textContent === "↳ 排队中")).toHaveLength(2);
  queued[0]!.text = "edited second"; await ui.loadHistory(false);
  expect(ui.state.messages.map((message) => message.id)).toEqual(["history", "q2", "q1"]);
  expect(flatten(root).some((node) => node.textContent === "edited second")).toBe(true);
  unavailable = true; await ui.loadHistory(false);
  expect(flatten(root).filter((node) => node.textContent === "排队状态待确认")).toHaveLength(2);
  unavailable = false; queued = []; sessionState = "idle"; await ui.loadHistory(false);
  expect(ui.state.messages.map((message) => message.id)).toEqual(["history"]);
  expect(nodes.get("session-meta")?.textContent).toBe("Codex · 创建来源未知 · 空闲");
  expect(flatten(root).some((node) => node.textContent.includes("排队"))).toBe(false);
});

test("Markdown renders structure without HTML execution and loads images only on click", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const render = runInNewContext(script.slice(0, end) + "\nrenderMarkdown", {
    URL, location: { origin: "http://100.112.22.85:7310" },
    document: {
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as (text: string) => ElementFixture;
  const root = render("# Title\n**bold**\n- item\n```js\n<script>unsafe</script>\n```\n| A | B |\n| --- | --- |\n| x | y |\n<img src=x onerror=unsafe>\n![sample](https://example.test/image.png)");
  const nodes = flatten(root);
  for (const tag of ["h1", "strong", "ul", "pre", "table"]) expect(nodes.some((node) => node.tag === tag)).toBe(true);
  expect(nodes.some((node) => node.tag === "script" || node.tag === "img")).toBe(false);
  const load = nodes.find((node) => node.tag === "button");
  if (!load?.onclick) throw new Error("image loader missing");
  load.onclick();
  expect(flatten(root).find((node) => node.tag === "img")?.src).toBe("https://example.test/image.png");
});

test("inline notice clamps after two lines, expands without auto-hide, and can be closed", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id)!; };
  get("console").hidden = false; get("notice-bar").hidden = true;
  get("notice-text").scrollHeight = 80; get("notice-text").clientHeight = 40;
  const delays: number[] = []; const cleared: number[] = [];
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, notice, toggleNoticeExpanded, clearNotice })", {
    document: { getElementById: get },
    requestAnimationFrame: (fn: () => void) => { fn(); return 1; },
    setTimeout: (_fn: () => void, delay: number) => { delays.push(delay); return delays.length; },
    clearTimeout: (id: number) => { cleared.push(id); },
  }) as {
    state: { noticeState: { expanded: boolean } };
    notice: (text: string, options?: { sticky?: boolean; kind?: string }) => void;
    toggleNoticeExpanded: () => void;
    clearNotice: () => void;
  };

  harness.notice("这是一条超过两行的较长提示，需要支持展开查看完整内容。");
  expect(get("notice-bar").hidden).toBe(false);
  expect(get("notice-toggle").hidden).toBe(false);
  expect(get("notice-toggle").textContent).toBe("展开");
  expect(delays.at(-1)).toBe(10000);

  harness.toggleNoticeExpanded();
  expect(harness.state.noticeState.expanded).toBe(true);
  expect(get("notice-bar").className).toContain("expanded");
  expect(get("notice-toggle").textContent).toBe("收起");
  expect(cleared.length).toBeGreaterThan(0);

  harness.toggleNoticeExpanded();
  expect(harness.state.noticeState.expanded).toBe(false);
  expect(get("notice-toggle").textContent).toBe("展开");
  expect(delays.at(-1)).toBe(10000);

  get("notice-text").scrollHeight = 30; get("notice-text").clientHeight = 40;
  harness.notice("短提示");
  expect(get("notice-toggle").hidden).toBe(true);
  expect(delays.at(-1)).toBe(6000);

  const timerCount = delays.length;
  get("notice-text").scrollHeight = 80;
  harness.notice("需要人工处理的错误信息", { sticky: true, kind: "error" });
  expect(get("notice-bar").className).toContain("notice-error");
  expect(delays.length).toBe(timerCount);
  harness.clearNotice();
  expect(get("notice-bar").hidden).toBe(true);
});

test("opening a session positions the first history page at the newest message", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, loadHistory })", {
    URL, URLSearchParams, location: { origin: "http://100.112.22.85:7310" },
    fetch: async () => Response.json({ data: { messages: [
      { id: "m1", role: "user", text: "older" },
      { id: "m2", role: "assistant", text: "latest" },
    ], cursor: "100" } }),
    document: {
      cookie: "",
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; selected: { id: string; source: string }; messages: Array<{ id: string }>; followLatest: boolean }; loadHistory: (older: boolean) => Promise<void> };
  harness.state.paused = false; harness.state.selected = { id: "session", source: "codex" }; harness.state.followLatest = false;
  await harness.loadHistory(false);
  expect(nodes.get("messages")?.scrollTop).toBe(1000);
  expect(nodes.get("messages")?.lastElementChild?.scrollIntoViewCalls).toBe(1);
});

test("latest polling preserves loaded older pages and their continuation boundary", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let latestCalls = 0;
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, loadHistory })", {
    URL, URLSearchParams, location: { origin: "http://100.112.22.85:7310" },
    fetch: async (value: string) => {
      const url = new URL(value, "http://100.112.22.85:7310");
      const cursor = url.searchParams.get("cursor");
      if (cursor === "200") return Response.json({ data: { messages: [{ id: "m1", role: "user", text: "1" }, { id: "m2", role: "assistant", text: "2" }], cursor: "100" } });
      latestCalls++;
      return Response.json({ data: latestCalls === 1
        ? { messages: [{ id: "m3", role: "user", text: "3" }, { id: "m4", role: "assistant", text: "4" }], cursor: "200" }
        : { messages: [{ id: "m4", role: "assistant", text: "4" }, { id: "m5", role: "assistant", text: "5" }], cursor: "300" } });
    },
    document: {
      cookie: "",
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; selected: { id: string; source: string }; messages: Array<{ id: string }>; historyCursor: string | null }; loadHistory: (older: boolean) => Promise<void> };
  harness.state.paused = false; harness.state.selected = { id: "session", source: "codex" };
  await harness.loadHistory(false);
  expect(harness.state.historyCursor).toBe("200");
  const messages = nodes.get("messages");
  if (!messages) throw new Error("messages fixture missing");
  Object.defineProperty(messages, "scrollHeight", { get: () => 1000 + messages.children.length * 100 });
  messages.scrollTop = 40;
  await harness.loadHistory(true);
  expect(messages.scrollTop).toBe(240);
  expect(harness.state.historyCursor).toBe("100");
  await harness.loadHistory(false);
  expect(harness.state.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  expect(harness.state.historyCursor).toBe("100");
});

test("execution polling never pins completed delivery status below the composer", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let execution = { state: "running", exact: true };
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, refreshExecutionStatus })", {
    URL, URLSearchParams,
    fetch: async () => Response.json({ data: {
      id: "op", kind: "send", source: "codex", state: "queued", sessionId: "session", turnId: null, errorCode: null,
      execution,
    } }),
    document: {
      cookie: "",
      hidden: false,
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; executionWatch: { operationId: string } | null }; refreshExecutionStatus: () => Promise<void> };
  harness.state.paused = false; harness.state.executionWatch = { operationId: "op" };
  await harness.refreshExecutionStatus();
  expect(nodes.get("operation-status")?.textContent).toBe("");
  expect(nodes.get("composer-footer")?.hidden).toBe(true);
  execution = { state: "running", exact: false };
  await harness.refreshExecutionStatus();
  expect(nodes.get("operation-status")?.textContent).toBe("");
  expect(nodes.get("composer-footer")?.hidden).toBe(true);
  execution = { state: "waiting_external_approval", exact: false };
  await harness.refreshExecutionStatus();
  expect(nodes.get("operation-status")?.textContent).toBe("");
  expect(nodes.get("composer-footer")?.hidden).toBe(true);
});

test("history follows a sent message and identifies a new final reply without replaying writes", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, loadHistory })", {
    URL, URLSearchParams, location: { origin: "http://100.112.22.85:7310" },
    fetch: async () => Response.json({ data: { messages: [{ id: "new-final", role: "assistant", text: "done", createdAt: 1 }], cursor: null } }),
    document: {
      cookie: "",
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; selected: { id: string; source: string }; followLatest: boolean; awaitingReply: { sessionId: string; source: string; baseline: string } | null }; loadHistory: (older: boolean) => Promise<void> };
  harness.state.paused = false; harness.state.selected = { id: "session", source: "codex" };
  harness.state.followLatest = true; harness.state.awaitingReply = { sessionId: "session", source: "codex", baseline: "old-final" };
  await harness.loadHistory(false);
  expect(nodes.get("messages")?.scrollTop).toBe(1000);
  expect(harness.state.awaitingReply).toBeNull();
  expect(nodes.get("operation-status")?.textContent).toBe("");
  expect(nodes.get("composer-footer")?.hidden).toBe(true);
});

test("mobile selection reveals the detail before positioning the latest history", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let detailVisible = false;
  let position = 0;
  const messages = new ElementFixture("div");
  Object.defineProperty(messages, "scrollTop", {
    get: () => position,
    set: (value: number) => { position = detailVisible ? value : 0; },
  });
  nodes.set("messages", messages);
  for (const id of ["source-filter", "session-search"]) {
    const input = new ElementFixture("input"); Object.assign(input, { value: "" }); nodes.set(id, input);
  }
  const sessions = new ElementFixture("div");
  Object.assign(sessions, { classList: { add: () => { detailVisible = true; }, remove: () => {} } });
  nodes.set("sessions", sessions);
  const harness = runInNewContext(script.slice(0, end) + '\nshowPage = async () => { await loadHistory(false); }; ({ state, loadSessions })', {
    URL, URLSearchParams, location: { origin: "http://100.112.22.85:7310" },
    fetch: async (path: string) => Response.json({ data: path.includes("/history?")
      ? { messages: [{ id: "latest", role: "assistant", text: "latest reply", createdAt: 1 }], cursor: "100" }
      : { items: [{ id: "session", source: "codex", title: "fixture", state: "unknown", sendEnabled: true }], capabilities: {}, cursor: null } }),
    document: {
      cookie: "",
      getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean }; loadSessions: (more: boolean) => Promise<void> };
  harness.state.paused = false;
  await harness.loadSessions(false);
  const button = nodes.get("session-items")?.children[0];
  if (!button?.onclick) throw new Error("selection callback missing");
  await button.onclick();
  expect(position).toBe(1000);
});

test("composer grows to three lines and shrinks after clearing without following older history", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const prompt = { style: { height: "" }, scrollHeight: 44 };
  const ui = runInNewContext(script.slice(0, end) + "\n({ resizeComposer })", {
    document: { getElementById: () => prompt },
    getComputedStyle: () => ({ lineHeight: "24px", paddingTop: "9px", paddingBottom: "9px", borderTopWidth: "1px", borderBottomWidth: "1px" }),
  }) as { resizeComposer: () => void };
  ui.resizeComposer(); expect(prompt.style.height).toBe("46px");
  prompt.scrollHeight = 200; ui.resizeComposer(); expect(prompt.style.height).toBe("92px");
  prompt.scrollHeight = 42; ui.resizeComposer(); expect(prompt.style.height).toBe("44px");
});

test("mobile visual viewport bounds the shell and reveals keyboard mode only for the composer", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const properties = new Map<string, string>(); let keyboard = false;
  const prompt = {};
  const document = { activeElement: prompt, getElementById: () => prompt, documentElement: {
    style: { setProperty: (key: string, value: string) => properties.set(key, value) },
    classList: { toggle: (_name: string, value: boolean) => { keyboard = value; } },
  } };
  const window = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 500, offsetTop: 16, scale: 1 } };
  const ui = runInNewContext(script.slice(0, end) + "\n({ syncViewport })", { window, document }) as { syncViewport: () => void };
  ui.syncViewport(); expect(properties.get("--app-height")).toBe("500px"); expect(properties.get("--app-top")).toBe("16px"); expect(keyboard).toBe(true);
  window.visualViewport.height = 844; ui.syncViewport(); expect(keyboard).toBe(false);
  window.visualViewport.height = 500; document.activeElement = {}; ui.syncViewport(); expect(keyboard).toBe(false);
});

test("latest shortcut refreshes online history and only scrolls cached history offline", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const messages = new ElementFixture("div"); const calls = { reads: 0 };
  const ui = runInNewContext(script.slice(0, end) + '\nloadHistory = async () => { calls.reads++; }; ({ state, jumpToLatest })', {
    document: { getElementById: () => messages },
    calls,
  }) as { state: { paused: boolean; selected: { id: string } | null }; jumpToLatest: () => Promise<void> };
  ui.state.selected = { id: "session" }; ui.state.paused = false;
  await ui.jumpToLatest(); expect(calls.reads).toBe(1); expect(messages.scrollTop).toBe(1000);
  messages.scrollTop = 10; ui.state.paused = true;
  await ui.jumpToLatest(); expect(calls.reads).toBe(1); expect(messages.scrollTop).toBe(1000);
});

test("earliest shortcut uses loaded history and cancels forced following", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let aligned = "";
  const messages = { scrollTop: 800, querySelector: (selector: string) => {
    expect(selector).toBe(".message");
    return { scrollIntoView: (options: { block: string }) => { aligned = options.block; } };
  } };
  const ui = runInNewContext(script.slice(0, end) + '\n({ state, jumpToEarliestLoaded })', {
    document: { getElementById: () => messages },
    fetch: () => { throw new Error("earliest navigation must not fetch"); },
  }) as { state: { followLatest: boolean }; jumpToEarliestLoaded: () => void };
  ui.state.followLatest = true; ui.jumpToEarliestLoaded();
  expect(messages.scrollTop).toBe(0); expect(aligned).toBe("start"); expect(ui.state.followLatest).toBe(false);
});

test("overview describes independent capabilities and Telegram stopped state without inventing availability", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const ui = runInNewContext(script.slice(0, end) + '\n({ state, loadStatus })', {
    URLSearchParams,
    fetch: async (path: string) => Response.json({ data: path === "/api/status" ? {
      observedAt: 1, sources: { codex: { state: "limited", capabilities: { sessionsReadable: true, historyReadable: false, createEnabled: false, sendEnabled: true } } },
      telegram: { stopped: true, pollFailed: false, lastPollSuccessAt: 1 },
    } : { items: [{ id: "one", source: "codex", title: "Recent conversation", state: "running", updatedAt: 1 }], cursor: "next", partial: true } }),
    document: {
      cookie: "", getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; settings: { redactionEnabled: boolean } }; loadStatus: () => Promise<void> };
  ui.state.paused = false; ui.state.settings = { redactionEnabled: true };
  await ui.loadStatus();
  const card = nodes.get("status-cards"); if (!card) throw new Error("status missing");
  const text = flatten(card).map((item) => item.textContent).join(" ");
  expect(text).toContain("历史读取"); expect(text).toContain("未就绪"); expect(text).toContain("已停止");
  expect(text).toContain("未接入");
  expect(nodes.get("overview-session-count")?.textContent).toBe("1+");
  expect(nodes.get("overview-session-scope")?.textContent).toContain("部分来源");
});

test("overview keeps actively probed status capabilities when the concurrent sessions snapshot is older", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const ui = runInNewContext(script.slice(0, end) + '\n({ state, loadStatus })', {
    URLSearchParams,
    fetch: async (path: string) => Response.json({ data: path === "/api/status" ? {
      observedAt: 1,
      sources: { codex: { state: "limited", capabilities: { sessionsReadable: true, historyReadable: true, projectsReadable: true, modelsReadable: true, createEnabled: true, sendEnabled: true } } },
      telegram: { stopped: false, pollFailed: false, lastPollSuccessAt: 1 },
    } : {
      items: [], cursor: null, partial: false,
      capabilities: { codex: { sessionsReadable: true, historyReadable: false, projectsReadable: false, modelsReadable: false, createEnabled: false, sendEnabled: true } },
    } }),
    document: {
      cookie: "", getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; },
    },
  }) as { state: { paused: boolean; settings: { redactionEnabled: boolean }; caps: Record<string, Record<string, boolean>> }; loadStatus: () => Promise<void> };
  ui.state.paused = false; ui.state.settings = { redactionEnabled: true };
  await ui.loadStatus();
  expect(ui.state.caps.codex).toMatchObject({ historyReadable: true, projectsReadable: true, modelsReadable: true, createEnabled: true });
});

test("unchanged history polling retains message nodes and expanded image state", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>(); let includeNewReply = false;
  const ui = runInNewContext(script.slice(0, end) + '\n({ state, loadHistory })', {
    URL, URLSearchParams, location: { origin: "http://100.112.22.85:7310" },
    fetch: async () => Response.json({ data: { messages: [{ id: "same", role: "assistant", text: "reply", createdAt: 1 }, ...(includeNewReply ? [{ id: "new", role: "assistant", text: "new reply", createdAt: 2 }] : [])], cursor: null } }),
    document: { cookie: "", getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode: (text: string) => { const value = new ElementFixture("#text"); value.textContent = text; return value; } },
  }) as { state: { paused: boolean; selected: { id: string; source: string } }; loadHistory: (older: boolean) => Promise<void> };
  ui.state.paused = false; ui.state.selected = { id: "session", source: "codex" };
  await ui.loadHistory(false);
  const messages = nodes.get("messages"); const reply = messages?.lastElementChild;
  if (!messages || !reply) throw new Error("message fixture missing");
  const expanded = new ElementFixture("img"); reply.append(expanded); messages.scrollTop = 40;
  await ui.loadHistory(false);
  expect(messages.lastElementChild).toBe(reply); expect(reply.lastElementChild).toBe(expanded); expect(messages.scrollTop).toBe(40);
  includeNewReply = true; await ui.loadHistory(false);
  expect(messages.children).toContain(reply); expect(reply.lastElementChild).toBe(expanded);
});

test("write acknowledgement does not erase a newer draft typed while waiting", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let complete: (value: unknown) => void = () => { throw new Error("submission not started"); };
  const response = new Promise<unknown>((resolve) => { complete = resolve; });
  const nodes: Record<string, { value: string; textContent: string; hidden: boolean; disabled: boolean; open: boolean; style: { height: string } }> = {};
  const ui = runInNewContext(script.slice(0, end) + '\noperationUuid = () => "operation"; api = () => response; refresh = async () => {}; notice = () => {}; ({ state, submitWrite })', {
    response, document: { getElementById(id: string) { return nodes[id] ??= { value: "", textContent: "", hidden: false, disabled: false, open: false, style: { height: "92px" } }; } },
  }) as { state: { selected: { id: string; source: string } }; submitWrite: (create: boolean) => Promise<void> };
  nodes.prompt = { value: "submitted draft", textContent: "", hidden: false, disabled: false, open: false, style: { height: "92px" } };
  ui.state.selected = { id: "session", source: "codex" };
  const sending = ui.submitWrite(false); nodes.prompt.value = "next draft";
  complete({ state: "queued", sessionId: "session", source: "codex", kind: "send" }); await sending;
  expect(nodes.prompt.value).toBe("next draft");
  expect(nodes.prompt.style.height).toBe("92px");
});

test("operation polling retains loaded older pages and their pagination boundary", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>(); let latestReads = 0;
  const ui = runInNewContext(script.slice(0, end) + '\napi = read; ({ state, loadRecords })', {
    URLSearchParams,
    read: async (path: string) => {
      if (path === "/api/logs") return { items: [] };
      const older = path.includes("cursor="); if (!older) latestReads++;
      return { items: [{ id: older ? "older" : latestReads > 1 ? "newest" : "latest", createdAt: older ? 0 : latestReads > 1 ? 2 : 1, state: "queued" }], cursor: older ? "oldest-page" : "latest-page" };
    },
    document: { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: "" })); return nodes.get(id); }, createElement: (tag: string) => new ElementFixture(tag) },
  }) as { state: { paused: boolean; recordCursor: string; records: Array<{ id: string }> }; loadRecords: (more: boolean) => Promise<void> };
  ui.state.paused = false;
  await ui.loadRecords(false); await ui.loadRecords(true); await ui.loadRecords(false);
  expect(ui.state.records.map((item) => item.id)).toEqual(["newest", "latest", "older"]);
  expect(ui.state.recordCursor).toBe("oldest-page");
});

test("overview routes to a clean source and activity-filtered session list", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, { value: string; textContent: string; classList: { add: () => void; remove: () => void } }>();
  const pages: string[] = [];
  const ui = runInNewContext(script.slice(0, end) + '\nshowPage = async (page) => { pages.push(page); }; ({ state, openOverviewSessions })', {
    pages, document: { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, { value: "old search", textContent: "", classList: { add() {}, remove() {} } }); return nodes.get(id); } },
  }) as { state: { paused: boolean }; openOverviewSessions: (source: string, activity: string) => Promise<void> };
  ui.state.paused = false;
  await ui.openOverviewSessions("codex", "running");
  expect(nodes.get("source-filter")?.value).toBe("codex"); expect(nodes.get("activity-filter")?.value).toBe("running");
  expect(nodes.get("session-search")?.value).toBe(""); expect(pages).toEqual(["sessions"]);
});

test("overview capability actions inspect catalogs and preselect creation without dispatch", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const actions: string[] = [];
  const ui = runInNewContext(script.slice(0, end) + `
    openOverviewCreate = async (source) => { actions.push("create:" + source); };
    openOverviewCatalog = async (source, kind) => { actions.push("catalog:" + source + ":" + kind); };
    openOverviewSessions = async (source) => { actions.push("sessions:" + source); };
    openOverviewCapability`, { actions }) as (source: string, capability: string) => Promise<void>;
  await ui("codex", "createEnabled"); await ui("dsh", "projectsReadable");
  await ui("codex", "modelsReadable"); await ui("codex", "historyReadable"); await ui("dsh", "sendEnabled");
  expect(actions).toEqual(["create:codex", "catalog:dsh:projects", "catalog:codex:models", "sessions:codex", "sessions:dsh"]);
});

test("offline overview browsing preserves messages and never submits or loads an uncached catalog", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>(); const notices: string[] = []; const requests: string[] = [];
  const ui = runInNewContext(script.slice(0, end) + `
    showPage = async () => {}; showConnectionNotice = (text) => { notices.push(text); };
    api = async (path) => { requests.push(path); throw new Error("offline must not fetch"); };
    ({ state, openOverviewSessions, openOverviewCreate, openOverviewCatalog })`, {
    notices, requests, document: {
      createElement: (tag: string) => new ElementFixture(tag),
      getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: "", classList: { add() {}, remove() {} } })); return nodes.get(id); },
    },
  }) as {
    state: { paused: boolean; overviewSessions: { id: string; source: string; title: string; state: string }[]; messages: { text: string }[] };
    openOverviewSessions: (source: string, activity: string) => Promise<void>;
    openOverviewCreate: (source: string) => Promise<void>; openOverviewCatalog: (source: string, kind: string) => Promise<void>;
  };
  ui.state.paused = true; ui.state.messages = [{ text: "retained reply" }];
  ui.state.overviewSessions = [{ id: "active", source: "codex", title: "active", state: "running" }, { id: "other", source: "dsh", title: "other", state: "unknown" }];
  await ui.openOverviewSessions("codex", "running"); await ui.openOverviewCreate("codex"); await ui.openOverviewCatalog("codex", "projects");
  expect(nodes.get("session-items")?.children.map((item) => item.children[0]?.textContent)).toEqual(["active"]);
  expect(ui.state.messages[0]?.text).toBe("retained reply"); expect(requests).toEqual([]); expect(notices).toHaveLength(2);
});

test("record title suggestions debounce for 500ms and reject stale results", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>(); const timers = new Map<number, () => void>(); const delays: number[] = [];
  let timerId = 0;
  const calls: string[] = []; const pending: ((value: unknown) => void)[] = [];
  const ui = runInNewContext(script.slice(0, end) + '\napi = read; ({ state, scheduleRecordSuggestions, loadRecordSuggestions })', {
    URLSearchParams, setTimeout: (fn: () => void, delay: number) => { delays.push(delay); timers.set(++timerId, fn); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    read: (path: string) => { calls.push(path); return new Promise((resolve) => pending.push(resolve)); },
    document: { createElement: (tag: string) => new ElementFixture(tag), getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: "", setAttribute() {} })); return nodes.get(id); } },
  }) as { state: { paused: boolean }; scheduleRecordSuggestions: () => void; loadRecordSuggestions: () => Promise<void> };
  ui.state.paused = false;
  const input = nodes.get("record-session") ?? Object.assign(new ElementFixture("input"), { value: "first", setAttribute() {} }); nodes.set("record-session", input);
  Object.assign(input, { value: "first" }); ui.scheduleRecordSuggestions();
  Object.assign(input, { value: "second" }); ui.scheduleRecordSuggestions();
  expect(delays).toEqual([500, 500]); expect(timers.size).toBe(1); expect(calls).toEqual([]);
  const old = ui.loadRecordSuggestions(); Object.assign(input, { value: "third" }); const fresh = ui.loadRecordSuggestions();
  pending[1]?.({ items: [{ source: "codex", id: "correct", title: "Third title" }] }); await fresh;
  pending[0]?.({ items: [{ source: "codex", id: "stale", title: "Old title" }] }); await old;
  const text = flatten(nodes.get("record-suggestions") ?? new ElementFixture("div")).map((item) => item.textContent).join(" ");
  expect(text).toContain("Third title"); expect(text).not.toContain("Old title");
});

test("record filtering uses selected source identity instead of a typed title and supports keyboard choice", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const ui = runInNewContext(script.slice(0, end) + '\n({ state, recordFilterParams, recordSuggestionKeydown })', {
    URLSearchParams, document: { getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: "" })); return nodes.get(id); } },
  }) as {
    state: { paused: boolean; recordChoice: { id: string; title: string; source: string } | null; recordSuggestions: { id: string; title: string; source: string }[] };
    recordFilterParams: () => URLSearchParams;
    recordSuggestionKeydown: (event: { key: string; preventDefault: () => void }) => void;
  };
  const input = Object.assign(new ElementFixture("input"), { value: "Typed title" }); nodes.set("record-session", input);
  expect(ui.recordFilterParams().get("sessionId")).toBe("");
  ui.state.paused = true; ui.state.recordSuggestions = [{ id: "shared", source: "codex", title: "Same title" }, { id: "shared", source: "dsh", title: "Same title" }];
  const list = new ElementFixture("div"); list.append(new ElementFixture("button"), new ElementFixture("button")); nodes.set("record-suggestions", list);
  ui.recordSuggestionKeydown({ key: "ArrowUp", preventDefault() {} });
  expect(input.attributes.get("aria-activedescendant")).toBe("record-option-1");
  ui.recordSuggestionKeydown({ key: "Enter", preventDefault() {} });
  expect(ui.recordFilterParams().get("source")).toBe("dsh"); expect(ui.recordFilterParams().get("sessionId")).toBe("shared");
  expect(input.value).toBe("Same title"); expect(list.hidden).toBe(true);
});

test("successful record refresh removes invalidated rows but preserves the older loaded window", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let items: { id: string; createdAt: number; state: string }[] = []; let cursor: string | null = "next";
  const ui = runInNewContext(script.slice(0, end) + '\napi = read; ({ state, loadRecords, recordFilterParams })', {
    URLSearchParams, read: async (path: string) => path.startsWith("/api/logs") ? { items: [] } : { items, cursor },
    document: { createElement: (tag: string) => new ElementFixture(tag), getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: id === "record-state" ? "queued" : "" })); return nodes.get(id); } },
  }) as { state: { paused: boolean; records: { id: string; createdAt: number; state: string }[]; recordFilterKey: string; recordCursor: string | null }; loadRecords: (more: boolean) => Promise<void>; recordFilterParams: () => URLSearchParams };
  ui.state.paused = false; ui.state.recordFilterKey = ui.recordFilterParams().toString(); ui.state.recordCursor = "older-page";
  ui.state.records = [{ id: "invalidated", createdAt: 3, state: "queued" }, { id: "kept", createdAt: 2, state: "queued" }, { id: "older", createdAt: 1, state: "queued" }];
  items = [{ id: "kept", createdAt: 2, state: "queued" }]; await ui.loadRecords(false);
  expect(ui.state.records.map((item) => item.id)).toEqual(["kept", "older"]); expect(ui.state.recordCursor).toBe("older-page");
  items = []; cursor = null; await ui.loadRecords(false);
  expect(ui.state.records).toEqual([]); expect(ui.state.recordCursor).toBeNull();
});

test("record pagination adjusts its offset when latest matching rows disappear", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  let matching = Array.from({ length: 65 }, (_, i) => ({ id: `record-${i + 1}`, createdAt: 65 - i, state: "queued" }));
  const ui = runInNewContext(script.slice(0, end) + '\napi = read; ({ state, loadRecords })', {
    URLSearchParams,
    read: async (path: string) => { if (path.startsWith("/api/logs")) return { items: [] }; const offset = Number(new URLSearchParams(path.split("?")[1]).get("cursor") ?? 0); return { items: matching.slice(offset, offset + 30), cursor: offset + 30 < matching.length ? String(offset + 30) : null }; },
    document: { createElement: (tag: string) => new ElementFixture(tag), getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: id === "record-state" ? "queued" : "" })); return nodes.get(id); } },
  }) as { state: { paused: boolean; records: { id: string }[]; recordCursor: string | null }; loadRecords: (more: boolean) => Promise<void> };
  ui.state.paused = false; await ui.loadRecords(false); await ui.loadRecords(true);
  expect(ui.state.recordCursor).toBe("60"); matching = matching.slice(1); await ui.loadRecords(false);
  expect(ui.state.recordCursor).toBe("59"); await ui.loadRecords(true);
  expect(ui.state.records.map((item) => item.id)).toEqual(matching.map((item) => item.id));
  expect(ui.state.recordCursor).toBeNull();
});


test("composer hides normal receipts but preserves actionable errors and newer submissions", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>();
  const harness = runInNewContext(script.slice(0, end) + "\n({ state, showOperation, setComposerStatus })", {
    document: { getElementById: (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); } },
  }) as { state: { pending: { operationId: string } | null }; showOperation: (operation: { id: string; state: string; execution?: { state: string } }, announce: boolean) => void; setComposerStatus: (text: string) => void };
  for (const state of ["queued", "accepted"]) {
    harness.showOperation({ id: "old", state }, false);
    expect(nodes.get("operation-status")?.textContent).toBe("");
    expect(nodes.get("composer-footer")?.hidden).toBe(true);
  }
  harness.showOperation({ id: "old", state: "failed" }, false);
  expect(nodes.get("operation-status")?.textContent).toContain("提交失败");
  expect(nodes.get("composer-footer")?.hidden).toBe(false);
  harness.state.pending = { operationId: "new" }; harness.setComposerStatus("发送中…");
  harness.showOperation({ id: "old", state: "queued", execution: { state: "running" } }, false);
  expect(nodes.get("operation-status")?.textContent).toBe("发送中…");
  harness.showOperation({ id: "new", state: "delivery_unknown" }, false);
  expect(nodes.get("operation-status")?.textContent).toContain("结果待确认");
  expect(nodes.get("reconcile")?.hidden).toBe(false);
});


test("queue age labels stay attached to confirmed native pending input", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const label = runInNewContext(script.slice(0, end) + "\nqueueStatusText", {}) as (message: { createdAt?: number; deliveryState: string }, now: number) => string;
  expect(label({ deliveryState: "queued", createdAt: 1000 }, 10000)).toBe("↳ 排队中");
  expect(label({ deliveryState: "queued", createdAt: 1000 }, 601000)).toBe("↳ 排队中 · 已等待 10 分钟");
  expect(label({ deliveryState: "queue_unknown", createdAt: 1000 }, 601000)).toBe("排队状态待确认");
  expect(label({ deliveryState: "queued" }, 601000)).toBe("↳ 排队中");
});

test("manual desktop opening requires confirmation and sends no message", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("async function openSelectedDesktop()");
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach', start);
  let allowed = false; const requests: string[] = []; const notices: string[] = [];
  const state = { paused: false, selected: { source: "codex", id: "thread" } };
  const button = { disabled: false };
  const open = runInNewContext(script.slice(start, end) + "\nopenSelectedDesktop", {
    state, confirm: () => allowed, el: () => button,
    api: async (path: string, method: string) => { requests.push(method + " " + path); },
    notice: (value: string) => notices.push(value),
  });
  await open(); expect(requests).toEqual([]);
  allowed = true; await open();
  expect(requests).toEqual(["POST /api/sessions/codex/thread/open-desktop"]);
  expect(notices[0]).toContain("是否开始执行"); expect(button.disabled).toBe(false);
  state.paused = true; await open(); expect(requests).toHaveLength(1);
  state.paused = false; state.selected.source = "dsh"; await open(); expect(requests).toHaveLength(1);
});

test("logout cancellation preserves pairing and confirmation revokes exactly once", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("async function confirmLogout()");
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach', start);
  let accepted = false; let writes = 0; let resets = 0;
  const logout = runInNewContext(script.slice(start, end) + "\nconfirmLogout", {
    confirm: () => accepted,
    api: async (path: string, method: string) => { expect(path).toBe("/api/auth/logout"); expect(method).toBe("POST"); writes++; },
    showLogin: () => { resets++; },
  });
  await logout(); expect(writes).toBe(0); expect(resets).toBe(0);
  accepted = true; await logout(); expect(writes).toBe(1); expect(resets).toBe(1);
});

test("running timer counts from native timestamp and hides on completion or missing evidence", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("function renderSessionStatus()");
  const end = script.indexOf("/** Format execution elapsed", start);
  let now = 100000;
  const state: { selected: { source: string; state: string; startedAt?: number } } = { selected: { source: "codex", state: "running", startedAt: 100000 } };
  const nodes = new Map<string, { hidden: boolean; textContent: string; title: string }>();
  const ui = runInNewContext(script.slice(script.indexOf("/** Keep platform labels"), script.indexOf("/** Apply a visual preference")) + "\n" + script.slice(start, end) + "\n({renderSessionStatus, formatRunningDuration})", {
    state, labels: { running: "执行中", idle: "空闲" }, Date: { now: () => now },
    el: (id: string) => { if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "", title: "" }); return nodes.get(id); },
  });
  ui.renderSessionStatus(); expect(nodes.get("execution-timer")?.textContent).toBe("已运行 0 秒");
  now += 83000; ui.renderSessionStatus(); expect(nodes.get("execution-timer")?.textContent).toBe("已运行 1 分 23 秒");
  now += 1000; ui.renderSessionStatus(); expect(nodes.get("execution-timer")?.textContent).toBe("已运行 1 分 24 秒");
  expect(ui.formatRunningDuration(3661000)).toBe("1 小时 1 分 1 秒");
  state.selected.state = "idle"; ui.renderSessionStatus(); expect(nodes.get("execution-timer")?.hidden).toBe(true);
  state.selected = { source: "codex", state: "running" }; ui.renderSessionStatus(); expect(nodes.get("execution-timer")?.hidden).toBe(true);
});

test("overview latest session ignores the last visited identity and follows refreshed ordering", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("function lastSessionPointer()");
  const end = script.indexOf("/** Route a single deliberate click", start);
  const old = { id: "old", source: "codex" }; const latest = { id: "latest", source: "dsh" };
  const newer = { id: "newer", source: "codex" };
  let calls = 0;
  const ui = runInNewContext(script.slice(start, end) + "\n({continueSessionTarget})", {
    state: { device: { id: "device" } }, URLSearchParams,
    localStorage: { getItem: () => JSON.stringify(old) },
    api: async () => { calls++; return { items: [old] }; },
  });
  expect(await ui.continueSessionTarget({ items: [latest, old] })).toEqual(latest);
  expect(await ui.continueSessionTarget({ items: [newer, latest, old] })).toEqual(newer);
  expect(await ui.continueSessionTarget({ items: [] })).toBeNull();
  expect(await ui.continueSessionTarget({ items: [latest], partial: true })).toEqual(latest);
  expect(calls).toBe(0);
});

test("continuation card rebuilds after privacy clearing even with unchanged identity", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("function renderContinueSession(session)");
  const end = script.indexOf("/** Render a bounded overview", start);
  const button = { hidden: true, dataset: { sessionSignature: "" }, childElementCount: 0, replaceChildren(...items: unknown[]) { this.childElementCount = items.length; } };
  const render = runInNewContext(script.slice(script.indexOf("/** Keep platform labels"), script.indexOf("/** Apply a visual preference")) + "\n" + script.slice(start, end) + "\nrenderContinueSession", {
    el: () => button, labels: { idle: "空闲" }, overviewTime: () => "fixture",
    node: () => ({ append() {} }),
  });
  const session = { source: "codex", id: "fixture", title: "test", state: "idle", updatedAt: 1 };
  render(session); expect(button.childElementCount).toBe(3);
  button.replaceChildren(); render(session); expect(button.childElementCount).toBe(3);
});

test("initial login network failure retains the gate rather than showing pairing", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("async function checkInitialLogin()");
  const end = script.indexOf("/** Invalidate the old display", start);
  const nodes = new Map<string, { hidden: boolean; textContent: string }>([["auth-loading", { hidden: false, textContent: "" }], ["auth-loading-retry", { hidden: true, textContent: "" }], ["auth-loading-text", { hidden: false, textContent: "" }]]);
  let code = "network_unavailable"; let retries = 0;
  const progress = script.slice(script.indexOf('let loginStage = "page"'), script.indexOf("/** Validate both session"));
  const check = runInNewContext(progress + script.slice(start, end) + "\ncheckInitialLogin", {
    state: {}, el: (id: string) => { if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "" }); return nodes.get(id); },
    bootstrap: async () => { throw Object.assign(new Error("fixture"), { code }); },
    scheduleReconnect: () => { retries++; },
  });
  await check(); expect(nodes.get("auth-loading")?.hidden).toBe(false);
  expect(nodes.get("auth-loading-retry")?.hidden).toBe(false); expect(retries).toBe(1);
  code = "auth_required"; await check(); expect(retries).toBe(1);
});

test("native image questions render compact attachment cards without raw paths or headings", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const ui = runInNewContext(script.slice(0, end) + "\n({ renderUserMessage, userAttachmentEnvelope })", {
    URL, location: { origin: "http://127.0.0.1:7310" }, document: {
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode(text: string) { const node = new ElementFixture("#text"); node.textContent = text; return node; },
    },
  }) as { renderUserMessage(message: { id: string; text: string }, session: { id: string; source: string }): ElementFixture; userAttachmentEnvelope(text: string): unknown };
  const text = '# Files mentioned by the user:\n\n## 照片 1.jpg: /tmp/codex-remote-attachments/thread/image.jpg\n\n## My request:\n看看这张图。<image name=[Image #1] path="/tmp/image.jpg"></image>';
  const root = ui.renderUserMessage({ id: "rollout-1", text }, { id: "thread", source: "codex" });
  const nodes = flatten(root); const content = nodes.map((node) => node.textContent).join(" ");
  expect(content).toContain("看看这张图。"); expect(content).toContain("照片 1.jpg");
  expect(content).not.toContain("/tmp/"); expect(content).not.toContain("Files mentioned"); expect(content).not.toContain("<image");
  expect(nodes.filter((node) => node.tag === "img")).toHaveLength(0);
  const button = nodes.find((node) => node.tag === "button")!; button.onclick?.();
  expect(flatten(root).find((node) => node.tag === "img")?.src).toBe("/api/sessions/codex/thread/attachments/rollout-1/0");
  button.onclick?.(); expect(flatten(root).filter((node) => node.tag === "img")).toHaveLength(1);
  expect(ui.userAttachmentEnvelope("ordinary message")).toBeNull();
});

test("loaded message images open an accessible preview and privacy clearing closes it", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const nodes = new Map<string, ElementFixture>(); let opened = 0; let closed = 0;
  const dialog = Object.assign(new ElementFixture("dialog"), { open: false, showModal() { this.open = true; opened++; }, close() { this.open = false; closed++; } });
  nodes.set("image-dialog", dialog);
  const ui = runInNewContext(script.slice(0, end) + "\n({ renderUserMessage, renderMarkdown, closeImagePreview, clearSensitive })", {
    URL, location: { origin: "http://127.0.0.1:7310" }, document: {
      getElementById(id: string) { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id); },
      createElement: (tag: string) => new ElementFixture(tag),
      createTextNode(text: string) { const node = new ElementFixture("#text"); node.textContent = text; return node; },
    },
  }) as { renderUserMessage(message: { id: string; text: string }, session: { id: string; source: string }): ElementFixture; renderMarkdown(text: string): ElementFixture; closeImagePreview(): void; clearSensitive(): void };
  const text = '# Files mentioned by the user:\n\n## image.jpg: /tmp/codex-remote-attachments/thread/image.jpg\n\n## My request:\nInspect.';
  const root = ui.renderUserMessage({ id: "rollout-1", text }, { id: "thread", source: "codex" });
  flatten(root).find((node) => node.tag === "button")!.onclick?.();
  const image = flatten(root).find((node) => node.tag === "img")!;
  expect(typeof image.onclick).toBe("function"); image.onclick?.();
  expect(opened).toBe(1); expect(nodes.get("image-dialog-image")?.src).toBe(new URL(image.src, "http://127.0.0.1:7310").href);
  expect(image.attributes.get("role")).toBe("button");
  ui.clearSensitive(); expect(closed).toBe(1); expect(nodes.get("image-dialog-image")?.src).toBe("");
  const markdown = ui.renderMarkdown("![sample](https://example.test/image.jpg)");
  flatten(markdown).find((node) => node.tag === "button")!.onclick?.();
  flatten(markdown).find((node) => node.tag === "img")!.onclick?.(); expect(opened).toBe(2);
  ui.closeImagePreview(); let prevented = false;
  image.onkeydown?.({ key: "Enter", preventDefault() { prevented = true; } });
  expect(prevented).toBe(true); expect(opened).toBe(3);
});

test("accepted and queued submissions reset cleared composer height while preserving newer drafts", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  for (const delivery of ["accepted", "queued", "failed", "delivery_unknown"]) {
    const nodes = new Map<string, ElementFixture & { value: string; style: { height: string } }>();
    /** Return a sized draft and ordinary controls for the submission fixture. */
    const get = (id: string) => {
      if (!nodes.has(id)) nodes.set(id, Object.assign(new ElementFixture("div"), { value: "", style: { height: "92px" } }));
      return nodes.get(id)!;
    };
    const ui = runInNewContext(script.slice(0, end) + '\noperationUuid = () => "operation"; api = async () => ({ state: delivery, sessionId: "session", source: "codex", kind: "send" }); refresh = async () => {}; notice = () => {}; ({ state, submitWrite })', {
      delivery, document: { getElementById: get },
    }) as { state: { selected: { id: string; source: string } }; submitWrite(create: boolean): Promise<void> };
    get("prompt").value = "multiline\ndraft"; ui.state.selected = { id: "session", source: "codex" };
    await ui.submitWrite(false);
    const cleared = delivery === "accepted" || delivery === "queued";
    expect(get("prompt").value).toBe(cleared ? "" : "multiline\ndraft");
    expect(get("prompt").style.height).toBe(cleared ? "" : "92px");
  }
});

test("floating latest shortcut follows scroll distance and jumps within the selected conversation", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const messages = new ElementFixture("div"); const button = new ElementFixture("button"); const earliest = new ElementFixture("button");
  const ui = runInNewContext(script.slice(0, end) + "\n({ state, updateLatestShortcut, jumpToLatest, jumpToEarliestLoaded })", {
    document: { getElementById: (id: string) => id === "messages" ? messages : id === "floating-earliest" ? earliest : button },
  }) as { state: { selected: { id: string; source: string } | null; messages: unknown[]; paused: boolean }; updateLatestShortcut(): void; jumpToLatest(): Promise<void>; jumpToEarliestLoaded(): void };
  ui.state.selected = { id: "thread", source: "codex" }; ui.state.messages = [{ id: "one" }];
  messages.scrollTop = 600; ui.updateLatestShortcut(); expect(button.hidden).toBe(true); expect(earliest.hidden).toBe(false);
  messages.scrollTop = 100; ui.updateLatestShortcut(); expect(button.hidden).toBe(false);
  await ui.jumpToLatest(); expect(button.hidden).toBe(true); expect(messages.scrollTop).toBe(1000);
  ui.jumpToEarliestLoaded(); expect(button.hidden).toBe(false); expect(earliest.hidden).toBe(true);
  messages.scrollTop = 550; ui.updateLatestShortcut(); expect(button.hidden).toBe(true);
  ui.state.messages = []; ui.updateLatestShortcut(); expect(button.hidden).toBe(true); expect(earliest.hidden).toBe(true);
  ui.state.messages = [{}]; ui.state.selected = null; ui.updateLatestShortcut(); expect(button.hidden).toBe(true);
});

test("message copying preserves content and supports HTTP selection fallback with cleanup", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let copied = ""; let removed = false; let focused = false; let allowed = true;
  const field = { value: "", style: {}, select() {}, setSelectionRange() {}, remove() { removed = true; } };
  const ui = runInNewContext(script.slice(0, end) + "\n({ copyMessageText, messageCopyText })", {
    document: { body: { append() {} }, activeElement: { focus() { focused = true; } }, createElement: () => field, execCommand(command: string) { expect(command).toBe("copy"); copied = field.value; return allowed; } },
  }) as { copyMessageText(text: string): Promise<void>; messageCopyText(message: { role: string; text: string }): string };
  await ui.copyMessageText("**bold**\ncode"); expect(copied).toBe("**bold**\ncode"); expect(removed).toBe(true); expect(focused).toBe(true);
  allowed = false; removed = false; await expect(ui.copyMessageText("retry")).rejects.toThrow("clipboard_unavailable"); expect(removed).toBe(true);
  const native = '# Files mentioned by the user:\n\n## image.jpg: /tmp/codex-remote-attachments/thread/image.jpg\n\n## My request:\nQuestion<image path="/tmp/image.jpg">';
  expect(ui.messageCopyText({ role: "user", text: native })).toBe("Question\n\n附件：image.jpg");
  expect(ui.messageCopyText({ role: "assistant", text: "# Answer\ntext" })).toBe("# Answer\ntext");
  const secure = runInNewContext(script.slice(0, end) + "\ncopyMessageText", { navigator: { clipboard: { async writeText(value: string) { copied = value; } } } }) as (text: string) => Promise<void>;
  await secure("secure message"); expect(copied).toBe("secure message");
});

test("copy icon reports actual clipboard success and leaves failures actionable", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let fail = false; let copied = ""; const notices: string[] = [];
  const ui = runInNewContext(script.slice(0, end) + '\nnotice = (text) => notices.push(text); copyMessageText = async (text) => { if (shouldFail()) throw new Error("denied"); save(text); }; ({ messageCopyButton })', {
    notices, shouldFail: () => fail, save: (text: string) => { copied = text; }, document: { createElement: (tag: string) => new ElementFixture(tag) },
  }) as { messageCopyButton(message: { role: string; text: string }): ElementFixture & { disabled: boolean; onclick(): Promise<void> } };
  const button = ui.messageCopyButton({ role: "assistant", text: "answer\ncode" });
  expect(button.attributes.get("aria-label")).toBe("复制消息");
  await button.onclick(); expect(copied).toBe("answer\ncode"); expect(notices.at(-1)).toBe("已复制消息"); expect(button.disabled).toBe(false);
  fail = true; await button.onclick(); expect(notices.at(-1)).toContain("无法自动复制"); expect(button.disabled).toBe(false);
});

test("theme restores valid preferences and remains usable when storage is restricted", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  let stored: string | null = "dark"; let denied = false; const dataset = { theme: "" }; const button = new ElementFixture("button");
  const ui = runInNewContext(script.slice(0, end) + "\n({ initializeTheme, toggleTheme })", {
    document: { documentElement: { dataset }, getElementById: () => button }, matchMedia: () => ({ matches: false }),
    localStorage: { getItem(key: string) { expect(key).toBe("sea-theme"); if (denied) throw new Error("blocked"); return stored; }, setItem(key: string, value: string) { expect(key).toBe("sea-theme"); if (denied) throw new Error("blocked"); stored = value; } },
  }) as { initializeTheme(): void; toggleTheme(): void };
  ui.initializeTheme(); expect(dataset.theme).toBe("dark"); expect(button.textContent).toContain("浅色");
  ui.toggleTheme(); expect(dataset.theme).toBe("light"); expect(stored).toBe("light"); expect(button.attributes.get("aria-pressed")).toBe("false");
  stored = "invalid"; ui.initializeTheme(); expect(dataset.theme).toBe("light");
  denied = true; ui.toggleTheme(); expect(dataset.theme).toBe("dark"); ui.initializeTheme(); expect(dataset.theme).toBe("light");
});

test("startup reports login versus settings requests and names the timed-out stage", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf('let loginStage = "page"'); const end = script.indexOf("/** Schedule bounded exponential", start);
  const nodes = new Map<string, ElementFixture>();
  /** Keep every progress and shell element independently observable. */
  const get = (id: string) => { if (!nodes.has(id)) nodes.set(id, new ElementFixture("div")); return nodes.get(id)!; };
  let release: (value: unknown) => void = () => {}; const pending = new Promise<unknown>((resolve) => { release = resolve; });
  const ui = runInNewContext(script.slice(start, end) + "\n({ validateConnection, showLoginFailure, updateLoginElapsed })", {
    el: get, state: { authEpoch: 0, version: 0 }, clearSensitive() {}, clientError: (code: string) => Object.assign(new Error(code), { code }),
    requestApi: async (path: string) => path === "/api/auth/session" ? pending : Promise.reject(Object.assign(new Error("timeout"), { code: "network_timeout" })),
  }) as { validateConnection(): Promise<void>; showLoginFailure(error: { code: string }): void; updateLoginElapsed(): void };
  const checking = ui.validateConnection(); expect(get("auth-loading-text").textContent).toContain("验证设备登录");
  ui.updateLoginElapsed(); expect(get("auth-loading-elapsed").textContent).toContain("当前步骤已等待");
  release({ device: { id: "test" }, settings: { version: 0 } }); await expect(checking).rejects.toThrow("timeout");
  expect(get("auth-step-session").className).toBe("complete"); expect(get("auth-step-settings").className).toBe("active");
  ui.showLoginFailure({ code: "network_timeout" }); expect(get("auth-loading-text").textContent).toBe("显示设置请求超时");
  expect(get("auth-loading-detail").textContent).toContain("HTTPS 域名和 Tunnel"); expect(get("auth-loading-detail").textContent).not.toContain("Tailscale");
  expect(get("auth-loading-spinner").hidden).toBe(true); expect(get("auth-loading-retry").hidden).toBe(false);
  expect(get("auth-loading").hidden).toBe(false); expect(get("auth-step-settings").className).toBe("failed");
});

test("overview snapshots require fresh device/policy verification and expire safely", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("/** Discard the overview snapshot"); const end = script.indexOf("/** Generate an RFC", start);
  let raw: string | null = null; let renders = 0; let blocked = false; let restored: unknown;
  const state = { page: "overview", device: { id: "device" }, settings: { version: 7 } };
  const freshness = new ElementFixture("p");
  const ui = runInNewContext(script.slice(start, end) + "\n({ saveOverviewCache, restoreOverviewCache, clearOverviewCache })", {
    state, el: () => freshness, renderOverview(_status: unknown, _sessions: unknown, continuation: unknown) { renders++; restored = continuation; }, localStorage: {
      getItem() { if (blocked) throw new Error("blocked"); return raw; }, setItem(_key: string, value: string) { if (blocked) throw new Error("blocked"); raw = value; }, removeItem() { raw = null; },
    },
  }) as { saveOverviewCache(status: unknown, sessions: { items: unknown[] }, continuation: unknown): void; restoreOverviewCache(): void; clearOverviewCache(): void };
  ui.saveOverviewCache({ observedAt: 1 }, { items: [{ id: "session", title: "last title" }] }, { id: "old" });
  const valid = raw!; ui.restoreOverviewCache(); expect(renders).toBe(1); expect(restored).toEqual({ id: "session", title: "last title" }); expect(freshness.textContent).toContain("上次数据");
  state.device.id = "other"; ui.restoreOverviewCache(); expect(renders).toBe(1); expect(raw).toBeNull();
  state.device.id = "device"; raw = valid; state.settings.version = 8; ui.restoreOverviewCache(); expect(renders).toBe(1); expect(raw).toBeNull();
  state.settings.version = 7; raw = JSON.stringify({ ...JSON.parse(valid), savedAt: Date.now() - 86400001 }); ui.restoreOverviewCache(); expect(raw).toBeNull();
  raw = "invalid"; ui.restoreOverviewCache(); expect(raw).toBeNull();
  raw = valid; ui.clearOverviewCache(); expect(raw).toBeNull();
  blocked = true; expect(() => ui.restoreOverviewCache()).not.toThrow(); expect(() => ui.saveOverviewCache({}, { items: [] }, null)).not.toThrow();
});
