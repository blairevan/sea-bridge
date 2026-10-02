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
  textContent = "";
  src = "";
  onclick?: () => void;
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  scrollIntoViewCalls = 0;
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
  await harness.loadHistory(true);
  expect(harness.state.historyCursor).toBe("100");
  await harness.loadHistory(false);
  expect(harness.state.messages.map((message) => message.id)).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  expect(harness.state.historyCursor).toBe("100");
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
  expect(nodes.get("operation-status")?.textContent).toBe("发现新的最终回复");
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
  Object.assign(sessions, { classList: { add: () => { detailVisible = true; } } });
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
