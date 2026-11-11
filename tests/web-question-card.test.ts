import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

/** Minimal typed DOM node fixture for exercising `src/web/public/app.js` in `node:vm`. */
class DomElementFixture {
  tag: string;
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  open = false;
  value = "";
  placeholder = "";
  type = "";
  title = "";
  id = "";
  tabIndex = 0;
  clientHeight = 40;
  scrollHeight = 40;
  scrollTop = 0;
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: DomElementFixture[] = [];
  parentElement: DomElementFixture | null = null;
  onclick: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onchange: (() => void) | null = null;
  onkeydown: ((event: { key: string; preventDefault: () => void }) => void) | null = null;
  classList = {
    items: new Set<string>(),
    add: (...tokens: string[]) => {
      for (const token of tokens) this.classList.items.add(token);
    },
    remove: (...tokens: string[]) => {
      for (const token of tokens) this.classList.items.delete(token);
    },
    contains: (token: string) => this.classList.items.has(token),
    toggle: (token: string, force?: boolean) => {
      const next = force ?? !this.classList.items.has(token);
      if (next) this.classList.items.add(token);
      else this.classList.items.delete(token);
      return next;
    },
  };

  /** Initialize a fixture element with the given HTML tag name. */
  constructor(tag: string) {
    this.tag = tag;
  }

  /** Append child fixtures and set parent pointers. */
  append(...items: DomElementFixture[]): void {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
  }

  /** Replace existing children with the supplied fixtures. */
  replaceChildren(...items: DomElementFixture[]): void {
    for (const prev of this.children) prev.parentElement = null;
    this.children = [];
    this.append(...items);
  }

  /** Remove this node from its parent fixture. */
  remove(): void {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  /** Record an HTML attribute value. */
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  /** Read an HTML attribute value. */
  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  /** Delete an HTML attribute value. */
  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  /** Focus no-op hook for input elements. */
  focus(): void {}

  /** Close dialog fixture. */
  close(): void {
    this.open = false;
  }

  /** Open modal dialog fixture. */
  showModal(): void {
    this.open = true;
  }

  /** Match basic `.class-name` selectors within descendants. */
  querySelectorAll(selector: string): DomElementFixture[] {
    if (!selector.startsWith(".")) return [];
    const targetClass = selector.slice(1);
    return flattenDom(this).filter((node) => node !== this && hasClass(node, targetClass));
  }
}

/** Flatten a fixture subtree in pre-order traversal. */
function flattenDom(root: DomElementFixture): DomElementFixture[] {
  const out: DomElementFixture[] = [root];
  for (const child of root.children) {
    out.push(...flattenDom(child));
  }
  return out;
}

/** Check whether a fixture element includes a CSS class token. */
function hasClass(el: DomElementFixture, token: string): boolean {
  return el.className.split(/\s+/).filter(Boolean).includes(token);
}

/** Collect all concatenated text inside a fixture subtree. */
function fullText(root: DomElementFixture): string {
  return flattenDom(root)
    .map((item) => item.textContent)
    .join("");
}

test("waiting_user_input state renders dedicated badge, filter option, overview count, and writable composer state", async () => {
  const html = await Bun.file("src/web/public/index.html").text();
  expect(html).toContain('<option value="waiting_user_input">等待输入</option>');

  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (end < 0) throw new Error("UI boundary missing");

  const nodes = new Map<string, DomElementFixture>();
  /** Retrieve or lazily construct a named DOM element fixture. */
  const get = (id: string): DomElementFixture => {
    if (!nodes.has(id)) {
      const created = new DomElementFixture("div");
      created.id = id;
      nodes.set(id, created);
    }
    return nodes.get(id)!;
  };

  const ui = runInNewContext(
    script.slice(0, end) +
      "\n({ state, sessionStateLabel, isReadOnlyDesktopSession, modelControlDisabledReason, liveActivityPresentation, syncComposerControl, renderOverview })",
    {
      Date,
      URL,
      encodeURIComponent,
      location: { origin: "http://127.0.0.1:7310" },
      document: {
        cookie: "",
        getElementById: get,
        createElement: (tag: string) => new DomElementFixture(tag),
        createTextNode: (text: string) => {
          const t = new DomElementFixture("#text");
          t.textContent = text;
          return t;
        },
      },
    },
  ) as {
    state: {
      paused: boolean;
      caps: Record<string, { sendEnabled?: boolean }>;
      selected: Record<string, unknown> | null;
      pending: unknown;
      settings: { redactionEnabled: boolean };
    };
    sessionStateLabel: (session: { state: string }) => string;
    isReadOnlyDesktopSession: (session: Record<string, unknown>) => boolean;
    modelControlDisabledReason: (session: { state: string }, catalogReady: boolean, updating: boolean) => string;
    liveActivityPresentation: (
      session: { state: string; source?: string } | null,
      paused: boolean,
      now: number,
    ) => { visible: boolean; status: string; detail: string };
    syncComposerControl: (now?: number) => void;
    renderOverview: (
      status: { observedAt: number; sources: Record<string, unknown>; telegram: Record<string, unknown> },
      sessions: { items: Array<Record<string, unknown>>; cursor: string | null; partial: boolean },
      continuation: Record<string, unknown> | null,
    ) => void;
  };

  ui.state.paused = false;
  expect(ui.sessionStateLabel({ state: "waiting_user_input" })).toBe("等待输入");
  expect(ui.modelControlDisabledReason({ state: "waiting_user_input" }, true, false)).toBe("等待输入时不能切换模型");

  expect(ui.liveActivityPresentation({ state: "waiting_user_input", source: "antigravity" }, false, 10_000)).toEqual({
    visible: true,
    status: "等待输入",
    detail: "请在问题卡片中选择或直接输入回复",
  });
  expect(ui.liveActivityPresentation({ state: "waiting_user_input", source: "antigravity" }, true, 10_000)).toEqual({
    visible: true,
    status: "连接重连中 · 最后已知等待输入",
    detail: "请在问题卡片中选择或直接输入回复",
  });

  ui.state.paused = false;
  ui.state.caps = { antigravity: { sendEnabled: true } };
  ui.state.settings = { redactionEnabled: true };

  const desktopWaitingSession = {
    source: "antigravity",
    id: "e9f53d80-2d9a-48e7-b5b6-38e29fe698c3",
    title: "ToolHub Task Execution Source Alignment",
    projectId: "toolhub",
    state: "waiting_user_input",
    sendEnabled: true,
    creationClient: { kind: "desktop", evidence: "explicit" },
  };
  expect(ui.isReadOnlyDesktopSession(desktopWaitingSession)).toBe(false);

  ui.state.selected = desktopWaitingSession;
  get("prompt").value = "";
  ui.syncComposerControl(10_000);
  expect(get("prompt").disabled).toBe(false);
  expect(get("composer-session-status").hidden).toBe(false);
  expect(get("composer-session-status").textContent).toBe("等待输入 · 请在问题卡片中选择或直接输入回复");
  expect(get("send-button").dataset.mode).toBe("send");
  expect(get("send-button").disabled).toBe(true);

  get("prompt").value = "1 1 1 1";
  ui.syncComposerControl(10_000);
  expect(get("send-button").dataset.mode).toBe("send");
  expect(get("send-button").disabled).toBe(false);

  ui.renderOverview(
    { observedAt: 10_000, sources: {}, telegram: {} },
    {
      items: [
        { ...desktopWaitingSession, updatedAt: 9_000 },
        {
          source: "codex",
          id: "codex-approval-1",
          title: "Approval Session",
          state: "waiting_external_approval",
          sendEnabled: false,
          updatedAt: 8_000,
        },
      ],
      cursor: null,
      partial: false,
    },
    null,
  );
  expect(get("overview-approval-count").textContent).toBe("2");
});

test("renderQuestionCard supports multi-question A1..AN, multiSelect checkboxes, and per-question custom answers while keeping single-select compatible", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (end < 0) throw new Error("UI boundary missing");

  const nodes = new Map<string, DomElementFixture>();
  /** Retrieve or lazily construct a named DOM element fixture. */
  const get = (id: string): DomElementFixture => {
    if (!nodes.has(id)) nodes.set(id, new DomElementFixture("div"));
    return nodes.get(id)!;
  };
  const submitted: string[] = [];

  const ui = runInNewContext(
    script.slice(0, end) +
      `
      resizeComposer = () => {};
      syncComposerControl = () => {};
      submitWrite = async (_create, promptOverride) => { submitted.push(promptOverride); };
      ({ state, renderAssistantMessage })`,
    {
      submitted,
      document: {
        getElementById: get,
        createElement: (tag: string) => new DomElementFixture(tag),
        createTextNode: (text: string) => {
          const t = new DomElementFixture("#text");
          t.textContent = text;
          return t;
        },
      },
    },
  ) as {
    state: { paused: boolean; selected: { id: string; source: string; sendEnabled: boolean }; pending: unknown };
    renderAssistantMessage: (message: {
      role: string;
      text: string;
      questions?: Array<{ title: string; options?: string[]; multiSelect?: boolean }>;
    }) => DomElementFixture;
  };

  ui.state.paused = false;
  ui.state.selected = { id: "agy-sess-1", source: "antigravity", sendEnabled: true };
  ui.state.pending = null;

  // 1. Multi-question card: Q1 single-select, Q2 multiSelect
  const multiCard = ui.renderAssistantMessage({
    role: "assistant",
    text: "",
    questions: [
      {
        title: "来源展示名称采用哪种规范？",
        options: ["(Recommended) 统一精简英文端名", "统一保留创建后缀", "统一中文端名"],
        multiSelect: false,
      },
      {
        title: "需要同步更新哪些通知渠道？",
        options: ["Web 控制台", "Telegram 机器人", "Vibe Notch 钉钉"],
        multiSelect: true,
      },
    ],
  });

  const multiNodes = flattenDom(multiCard);
  expect(fullText(multiCard)).toContain("1/2");
  expect(fullText(multiCard)).toContain("2/2");
  expect(fullText(multiCard)).toContain("可多选");

  const sendBtn = multiNodes.find((n) => hasClass(n, "question-send-btn"));
  if (!sendBtn) throw new Error("missing send button");
  // Q2 (multiSelect) starts with 0 selections, so send button is disabled until Q2 has at least 1 answer
  expect(sendBtn.disabled).toBe(true);

  const optionBtns = multiNodes.filter((n) => hasClass(n, "question-option-btn"));
  expect(optionBtns).toHaveLength(6);
  expect(optionBtns[0]?.getAttribute("role")).toBe("radio");
  expect(optionBtns[3]?.getAttribute("role")).toBe("checkbox");

  // Select Q2 options 1 and 3 (indices 3 and 5)
  optionBtns[3]?.onclick?.();
  optionBtns[5]?.onclick?.();
  expect(sendBtn.disabled).toBe(false);

  // Toggle Q1 to custom input ("其他（自定义输入）")
  const otherToggles = multiNodes.filter((n) => hasClass(n, "question-other-toggle"));
  expect(otherToggles).toHaveLength(2);
  otherToggles[0]?.onclick?.();

  const otherInputs = multiNodes.filter((n) => hasClass(n, "question-other-input"));
  expect(otherInputs).toHaveLength(2);
  expect(otherInputs[0]?.hidden).toBe(false);
  // While Q1 custom input is empty, sendBtn becomes disabled
  expect(sendBtn.disabled).toBe(true);

  otherInputs[0]!.value = "自定义规范：平台 · 端名";
  otherInputs[0]?.oninput?.();
  expect(sendBtn.disabled).toBe(false);

  sendBtn.onclick?.();
  expect(submitted).toEqual([
    "A1: 自定义规范：平台 · 端名\nA2: Web 控制台；Vibe Notch 钉钉",
  ]);
});

test("submitWrite handles desktop_takeover_confirm_required with fresh operationId + forceDesktopTakeover retry or safe cancel", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (end < 0) throw new Error("UI boundary missing");

  const nodes = new Map<string, DomElementFixture>();
  /** Retrieve or lazily construct a named DOM element fixture. */
  const get = (id: string): DomElementFixture => {
    if (!nodes.has(id)) nodes.set(id, new DomElementFixture("div"));
    return nodes.get(id)!;
  };
  get("console").hidden = false;

  let uuidSeq = 0;
  const apiCalls: Array<{ path: string; method?: string; body?: Record<string, unknown> }> = [];
  const confirmCalls: string[] = [];
  let confirmDecision: boolean | undefined = true;

  const ui = runInNewContext(
    script.slice(0, end) +
      `
      operationUuid = () => "00000000-0000-4000-8000-" + String(++uuidSeq).padStart(12, "0");
      refresh = async () => {};
      api = async (path, method, body) => {
        apiCalls.push({ path, method, body });
        if (!body?.forceDesktopTakeover) {
          return {
            id: body.operationId,
            kind: "send",
            source: "antigravity",
            sessionId: "desk-sess-1",
            state: "failed",
            errorCode: "desktop_takeover_confirm_required",
            createdAt: 1000,
          };
        }
        return {
          id: body.operationId,
          kind: "send",
          source: "antigravity",
          sessionId: "desk-sess-1",
          state: "accepted",
          createdAt: 1001,
        };
      };
      ({
        state,
        submitWrite,
        setConfirmImpl: (fn) => { confirm = fn; },
      })`,
    {
      uuidSeq,
      apiCalls,
      confirm: (msg: string) => {
        confirmCalls.push(msg);
        return Boolean(confirmDecision);
      },
      encodeURIComponent,
      document: {
        getElementById: get,
        createElement: (tag: string) => new DomElementFixture(tag),
        createTextNode: (text: string) => {
          const t = new DomElementFixture("#text");
          t.textContent = text;
          return t;
        },
      },
    },
  ) as {
    state: {
      paused: boolean;
      selected: { id: string; source: string; sendEnabled: boolean };
      pending: unknown;
      messages: Array<{ id: string; role: string }>;
    };
    submitWrite: (
      create: boolean,
      promptOverride?: string,
      writeOptions?: { forceDesktopTakeover?: boolean },
    ) => Promise<void>;
    setConfirmImpl: (fn: ((msg: string) => boolean) | undefined) => void;
  };

  ui.state.paused = false;
  ui.state.selected = { id: "desk-sess-1", source: "antigravity", sendEnabled: true };
  ui.state.pending = null;
  ui.state.messages = [];

  // Case 1: User confirms takeover -> retries immediately with new operationId + forceDesktopTakeover: true
  await ui.submitWrite(false, "A1: 方案一");
  expect(confirmCalls).toHaveLength(1);
  expect(apiCalls).toHaveLength(2);
  expect(apiCalls[0]?.body).toEqual({
    operationId: "00000000-0000-4000-8000-000000000001",
    prompt: "A1: 方案一",
  });
  expect(apiCalls[1]?.body).toEqual({
    operationId: "00000000-0000-4000-8000-000000000002",
    prompt: "A1: 方案一",
    forceDesktopTakeover: true,
  });

  // Case 2: User cancels takeover -> does NOT retry and preserves composer draft
  apiCalls.length = 0;
  confirmCalls.length = 0;
  confirmDecision = false;
  get("prompt").value = "保留的草稿";
  await ui.submitWrite(false);
  expect(confirmCalls).toHaveLength(1);
  expect(apiCalls).toHaveLength(1);
  expect(get("prompt").value).toBe("保留的草稿");

  // Case 3: Headless environment without window.confirm -> shows sticky warning with actionable retry button
  apiCalls.length = 0;
  ui.setConfirmImpl(undefined);
  await ui.submitWrite(false, "无弹窗环境回答");
  expect(apiCalls).toHaveLength(1);
  expect(get("notice-bar").hidden).toBe(false);
  expect(get("notice-retry").hidden).toBe(false);
  expect(get("notice-retry").textContent).toBe("强制接管并提交");
  get("notice-retry").onclick?.();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(apiCalls).toHaveLength(2);
  expect(apiCalls[1]?.body?.forceDesktopTakeover).toBe(true);
});
