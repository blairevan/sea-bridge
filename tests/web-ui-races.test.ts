import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

/** Minimal DOM retaining state needed to observe asynchronous UI boundaries. */
class RaceElement {
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  open = false;
  checked = false;
  className = "";
  dataset: Record<string, string> = {};
  children: RaceElement[] = [];
  scrollTop = 0;
  scrollHeight = 100;
  clientHeight = 50;
  onchange?: () => void;
  onclick?: () => void;
  classList = { remove() {}, add() {}, contains() { return false; } };
  /** Preserve child structure without parsing source-derived HTML. */
  append(...children: RaceElement[]): void { this.children.push(...children); }
  /** Replace visible fixture children. */
  replaceChildren(...children: RaceElement[]): void { this.children = children; }
  /** Accept accessibility attributes used by the combobox. */
  setAttribute(): void {}
  /** Accept removal of transient accessibility attributes. */
  removeAttribute(): void {}
  /** Close a fixture dialog. */
  close(): void { this.open = false; }
  /** Open a fixture dialog after verified catalog rendering. */
  showModal(): void { this.open = true; }
  /** Expose the option initialized by catalog loading. */
  get firstChild(): RaceElement | undefined { return this.children[0]; }
  /** Expose the newest rendered message for scroll positioning. */
  get lastElementChild(): RaceElement | undefined { return this.children.at(-1); }
  /** Ignore scrolling while preserving the rendered message structure. */
  scrollIntoView(): void {}
  /** No nested controls are required in this bounded fixture. */
  querySelectorAll(): RaceElement[] { return []; }
  /** No settings submit button is required in this bounded fixture. */
  querySelector(): null { return null; }
}

/** Create a manually completed promise to specify request completion order. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => { throw new Error("deferred promise not initialized"); };
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

/** Load production helpers with an isolated text-only DOM and no live endpoints. */
async function fixture(extra: Record<string, unknown> = {}, appended = "") {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const nodes = new Map<string, RaceElement>();
  /** Return one stable node per application ID. */
  const element = (id: string): RaceElement => {
    let value = nodes.get(id);
    if (!value) { value = new RaceElement(); nodes.set(id, value); }
    return value;
  };
  const context = {
    URL, URLSearchParams,
    crypto: { randomUUID: () => "fixture-operation" },
    document: {
      hidden: false, cookie: "", getElementById: element,
      createElement: () => new RaceElement(),
      createTextNode: (text: string) => Object.assign(new RaceElement(), { textContent: text }),
    },
    ...extra,
  };
  return { script, element, evaluate: (source: string): unknown => runInNewContext(script.slice(0, boundary) + appended + "\n" + source, context) };
}

/** Drain asynchronous response-body reads and their dependent UI continuations. */
async function settle(): Promise<void> { await new Promise<void>((resolve) => setImmediate(resolve)); }

test("project search debounces for 500ms, preserves matching selection and handles no results", async () => {
  let nextId = 0;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const ui = await fixture({
    setTimeout(callback: () => void, delay: number) { const id = ++nextId; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  }, '\ncreationProjects = { source: "codex", items: [{ id: "one", name: "SEA Bridge" }, { id: "two", name: "数字人创课" }] };\n');
  const helpers = ui.evaluate("({ state, renderCreationProjects, scheduleProjectSearch, resetProjectSearch })") as {
    state: { paused: boolean; caps: Record<string, { createEnabled: boolean }> };
    renderCreationProjects(selection?: string): void; scheduleProjectSearch(): void; resetProjectSearch(): void;
  };
  helpers.state.paused = false; helpers.state.caps = { codex: { createEnabled: true } };
  ui.element("create-source").value = "codex"; helpers.renderCreationProjects("two");
  expect(ui.element("create-project").value).toBe("two");
  ui.element("create-project-search").value = "missing"; helpers.scheduleProjectSearch();
  ui.element("create-project-search").value = "  sea  "; helpers.scheduleProjectSearch();
  expect(timers.size).toBe(1); expect(ui.element("create-project").children).toHaveLength(2);
  const timer = [...timers.values()][0]; if (!timer) throw new Error("search timer missing");
  expect(timer.delay).toBe(500); timers.clear(); timer.callback();
  expect(ui.element("create-project").children.map((option) => option.textContent)).toEqual(["SEA Bridge"]);
  expect(ui.element("create-project").value).toBe("");
  expect(ui.element("create-submit").disabled).toBe(true);
  const choice = ui.element("create-project-options").children[0];
  if (!choice?.onclick) throw new Error("project choice missing");
  choice.onclick();
  expect(ui.element("create-project").value).toBe("one");
  expect(ui.element("create-project-search").value).toBe("SEA Bridge");
  expect(ui.element("create-project-options").hidden).toBe(true);
  ui.element("create-project-search").value = "不存在"; helpers.renderCreationProjects();
  expect(ui.element("create-project").value).toBe(""); expect(ui.element("create-submit").disabled).toBe(true);
  expect(ui.element("create-project-options").children[0]?.textContent).toBe("没有匹配的项目");
  ui.element("create-project-search").value = ""; helpers.renderCreationProjects();
  expect(ui.element("create-project").children).toHaveLength(2); expect(ui.element("create-submit").disabled).toBe(false);
  ui.element("create-project-search").value = "创课"; helpers.renderCreationProjects("two");
  expect(ui.element("create-project").value).toBe("two");
  helpers.scheduleProjectSearch(); helpers.resetProjectSearch();
  expect(timers.size).toBe(0); expect(ui.element("create-project-search").value).toBe("");
  ui.element("create-source").value = "dsh"; helpers.renderCreationProjects();
  expect(ui.element("create-project").value).toBe("");
});

test("a previous identity cannot block the same action after reauthentication", async () => {
  const ui = await fixture(); const held = deferred<void>(); let actions = 0;
  const helpers = ui.evaluate("({ run, showLogin })") as { run: (key: string, work: () => Promise<void>) => Promise<void>; showLogin: () => void };
  const previous = helpers.run("write", () => held.promise);
  helpers.showLogin();
  await helpers.run("write", async () => { actions++; });
  held.resolve(); await previous; expect(actions).toBe(1);
});

test("an old read cannot delete or reuse a new identity's coalesced request", async () => {
  const oldRead = deferred<Response>(); const newRead = deferred<Response>(); let requests = 0;
  const ui = await fixture({ fetch: () => ++requests === 1 ? oldRead.promise : newRead.promise });
  const helpers = ui.evaluate("({ state, api, showLogin })") as { state: { paused: boolean; version: number }; api: (path: string) => Promise<unknown>; showLogin: () => void };
  helpers.state.paused = false; helpers.state.version = 1;
  const previous = helpers.api("/api/operations/op").catch((error: unknown) => error);
  helpers.showLogin(); helpers.state.paused = false; helpers.state.version = 1;
  const current = helpers.api("/api/operations/op");
  oldRead.resolve(Response.json({ data: {} }, { status: 401, headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await previous;
  const coalesced = helpers.api("/api/operations/op");
  expect(requests).toBe(2); expect(helpers.state.paused).toBe(false);
  newRead.resolve(Response.json({ data: { id: "new" } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  expect(await current).toEqual({ id: "new" }); expect(await coalesced).toEqual({ id: "new" });
});

test("creation resets the previous conversation history and pagination boundary", async () => {
  const ui = await fixture({}, `
api = async (path, method) => method === "POST"
  ? { state: "accepted", sessionId: "new-session" }
  : { messages: [{ id: "new-message", role: "assistant", text: "new reply" }], cursor: null };
showPage = async () => loadHistory(false);
refresh = async () => {};
notice = () => {};
`);
  const helpers = ui.evaluate("({ state, submitWrite })") as {
    state: { paused: boolean; selected: { id: string; source: string }; messages: { id: string; role: string; text: string }[]; historyCursor: string | null };
    submitWrite: (create: boolean) => Promise<void>;
  };
  helpers.state.paused = false;
  helpers.state.selected = { id: "old-session", source: "codex" };
  helpers.state.messages = [{ id: "old-message", role: "user", text: "previous conversation" }];
  helpers.state.historyCursor = "old-boundary";
  ui.element("create-source").value = "codex";
  ui.element("create-prompt").value = "new task";
  await helpers.submitWrite(true);
  expect(helpers.state.selected.id).toBe("new-session");
  expect(helpers.state.messages.map((message) => message.id)).toEqual(["new-message"]);
  expect(helpers.state.historyCursor).toBeNull();
});

test("overview rejects a completed old-policy read when its companion crosses policy invalidation", async () => {
  const sessions = deferred<Response>(); const status = deferred<Response>();
  const ui = await fixture({ fetch: (path: string) => path.startsWith("/api/sessions") ? sessions.promise : status.promise });
  const helpers = ui.evaluate("({ state, loadStatus, clearSensitive })") as {
    state: { paused: boolean; version: number; overviewSessions: { title: string }[] };
    loadStatus: () => Promise<void>; clearSensitive: () => void;
  };
  helpers.state.paused = false;
  const work = helpers.loadStatus().catch(() => {});
  sessions.resolve(Response.json({ data: { items: [{ id: "private", source: "codex", title: "old-policy private title" }], cursor: null } }, { headers: { "X-Sea-Bridge-Settings-Version": "0" } }));
  await settle();
  helpers.clearSensitive(); helpers.state.version = 1;
  status.resolve(Response.json({ data: { sources: {}, telegram: {}, observedAt: 1 } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await work;
  expect(helpers.state.overviewSessions).toEqual([]);
});

test("catalog rendering rejects policy invalidation between the API and its caller", async () => {
  const read = deferred<Response>();
  const ui = await fixture({ fetch: () => read.promise });
  const helpers = ui.evaluate("({ state, reads, clearSensitive, openOverviewCatalog })") as {
    state: { paused: boolean; version: number; catalogContext: unknown };
    reads: Map<string, Promise<unknown>>; clearSensitive: () => void;
    openOverviewCatalog: (source: string, kind: string) => Promise<void>;
  };
  helpers.state.paused = false;
  const work = helpers.openOverviewCatalog("codex", "projects");
  const pending = helpers.reads.get("/api/sources/codex/projects");
  if (!pending) throw new Error("catalog request missing");
  // A separate control-event microtask runs after request validation and before rendering.
  const invalidation = pending.then(() => { helpers.clearSensitive(); helpers.state.version = 1; });
  read.resolve(Response.json({ data: { items: [{ id: "old", name: "old-policy private project" }] } }, { headers: { "X-Sea-Bridge-Settings-Version": "0" } }));
  await Promise.all([work, invalidation]);
  expect(helpers.state.catalogContext).toBeNull();
  expect(ui.element("catalog-items").children).toEqual([]);
});

test("reauthentication cannot adopt a response requested by the previous identity", async () => {
  const read = deferred<Response>();
  const ui = await fixture({ fetch: () => read.promise });
  const helpers = ui.evaluate("({ state, api, showLogin })") as {
    state: { paused: boolean }; api: (path: string) => Promise<unknown>; showLogin: () => void;
  };
  helpers.state.paused = false;
  const outcome = helpers.api("/api/operations").then(() => "accepted", () => "rejected");
  helpers.showLogin();
  // A new pairing and validated SSE connection have now unpaused the same shell.
  helpers.state.paused = false; ui.element("console").hidden = false;
  read.resolve(Response.json({ data: { items: [{ id: "previous-identity-record" }] } }, { headers: { "X-Sea-Bridge-Settings-Version": "0" } }));
  expect(await outcome).toBe("rejected");
});

/** Controllable SSE fixture for back-to-back display-policy events. */
class RaceStream {
  static OPEN = 1;
  readyState = 1;
  onopen?: () => void;
  callbacks = new Map<string, (event: { data: string }) => void>();
  /** Register named control events without a network connection. */
  addEventListener(name: string, callback: (event: { data: string }) => void): void { this.callbacks.set(name, callback); }
  /** Mark a closed stream as unavailable for recovery checks. */
  close(): void { this.readyState = 2; }
}

test("consecutive settings events retain a recovery path after stale validation", async () => {
  const auth = deferred<Response>();
  const ui = await fixture({ EventSource: RaceStream, fetch: () => auth.promise, setTimeout: () => 1, clearTimeout() {} }, "\nnotice = () => {};\n");
  const helpers = ui.evaluate("({ state, connectEvents })") as {
    state: { paused: boolean; version: number; stream: RaceStream; reconnectTimer: number | null; recovering: boolean };
    connectEvents: () => void;
  };
  helpers.state.paused = false; helpers.connectEvents();
  const handler = helpers.state.stream.callbacks.get("settings_version");
  if (!handler) throw new Error("settings event handler missing");
  handler({ data: '{"version":1}' }); handler({ data: '{"version":2}' });
  auth.resolve(Response.json({ data: { settings: { version: 1 } } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await settle();
  expect(helpers.state.version).toBeGreaterThanOrEqual(1);
  expect(!helpers.state.paused || helpers.state.reconnectTimer !== null || helpers.state.recovering).toBe(true);
});

test("settings recovery validates version two on a new stream despite an older unfinished recovery", async () => {
  const oldAuth = deferred<Response>(); let authReads = 0;
  const ui = await fixture({
    EventSource: RaceStream,
    fetch: (path: string) => {
      if (path === "/api/auth/session" && ++authReads === 1) return oldAuth.promise;
      const data = path === "/api/auth/session" ? { device: { id: "current" }, settings: { version: 2 } } : { version: 2, redactionEnabled: true };
      return Promise.resolve(Response.json({ data }, { headers: { "X-Sea-Bridge-Settings-Version": "2" } }));
    },
    setTimeout: () => 1, clearTimeout() {},
  }, "\nrefresh = async () => {}; notice = () => {};\n");
  const helpers = ui.evaluate("({ state, connectEvents, finishRecovery, recoverConnection })") as {
    state: { paused: boolean; version: number; stream: RaceStream | null; recovering: boolean };
    connectEvents: () => void; finishRecovery: (stream: RaceStream) => Promise<void>; recoverConnection: () => Promise<void>;
  };
  helpers.connectEvents();
  const oldStream = helpers.state.stream;
  if (!oldStream) throw new Error("initial stream missing");
  const oldRecovery = helpers.finishRecovery(oldStream).catch(() => {});
  const oldHandler = oldStream.callbacks.get("settings_version");
  if (!oldHandler) throw new Error("initial settings handler missing");
  oldHandler({ data: '{"version":1}' }); oldHandler({ data: '{"version":2}' });
  // A validation that learns a newer policy may schedule one extra fresh attempt.
  for (let attempt = 0; attempt < 3 && (!helpers.state.stream || helpers.state.stream === oldStream); attempt++) await helpers.recoverConnection();
  const stream = helpers.state.stream;
  expect(stream).not.toBe(oldStream);
  if (!stream) throw new Error("replacement stream missing");
  stream.callbacks.get("settings_version")?.({ data: '{"version":2}' });
  await helpers.finishRecovery(stream);
  expect(helpers.state.paused).toBe(false); expect(helpers.state.version).toBe(2);
  oldAuth.resolve(Response.json({ data: { settings: { version: 1 } } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await oldRecovery;
  expect(helpers.state.stream).toBe(stream);
  expect(helpers.state.paused).toBe(false); expect(helpers.state.version).toBe(2);
});

test("switching creation source during loading starts the final source catalog request", async () => {
  const codexProjects = deferred<{ items: { id: string; name: string }[] }>();
  const calls: string[] = [];
  const ui = await fixture({ read: async (path: string) => {
    calls.push(path);
    if (path === "/api/sources/codex/projects") return codexProjects.promise;
    return { items: [{ id: "dsh-project", name: "dsh project" }] };
  } }, '\napi = read; loadSessions = async () => {}; notice = () => {};\n');
  const binding = ui.script.split("\n").find((line) => line.startsWith('el("create-source").onchange ='));
  if (!binding) throw new Error("catalog source binding missing");
  const helpers = ui.evaluate(binding + "\n({ state, run, loadCatalogs })") as {
    state: { paused: boolean; caps: Record<string, { createEnabled: boolean }> };
    run: (key: string, work: () => Promise<void>) => Promise<void>; loadCatalogs: () => Promise<void>;
  };
  helpers.state.paused = false; helpers.state.caps = { dsh: { createEnabled: true } };
  ui.element("create-source").value = "codex";
  const old = helpers.run("catalog", helpers.loadCatalogs);
  ui.element("create-source").value = "dsh"; ui.element("create-source").onchange?.();
  codexProjects.resolve({ items: [{ id: "codex-project", name: "codex project" }] });
  await old; await settle();
  expect(calls).toContain("/api/sources/dsh/projects");
  expect(calls).toContain("/api/sources/dsh/models");
  expect(ui.element("create-submit").disabled).toBe(false);
});
