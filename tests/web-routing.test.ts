import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

interface StorageMock {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
  clear: () => void;
}

function createStorage(): StorageMock {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

async function loadRoutingHarness(options: {
  pathname?: string;
  storage?: StorageMock;
} = {}) {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  if (end < 0) throw new Error("UI boundary missing");

  const storage = options.storage ?? createStorage();
  const pathname = options.pathname ?? "/";
  const historyEntries: Array<{ state: unknown; url: string; replace: boolean }> = [];
  const location = { origin: "http://127.0.0.1:7310", pathname };
  let backCalls = 0;
  const history = {
    pushState: (state: unknown, _title: string, url: string) => {
      historyEntries.push({ state, url, replace: false });
      location.pathname = url;
    },
    replaceState: (state: unknown, _title: string, url: string) => {
      historyEntries.push({ state, url, replace: true });
      location.pathname = url;
    },
    back: () => {
      backCalls++;
      if (historyEntries.length > 1) historyEntries.pop();
    },
    get backCalls() {
      return backCalls;
    },
  };

  const makeClassList = () => {
    const classes = new Set<string>();
    return {
      add: (...items: string[]) => items.forEach((c) => classes.add(c)),
      remove: (...items: string[]) => items.forEach((c) => classes.delete(c)),
      contains: (c: string) => classes.has(c),
      toggle: (cls: string, active?: boolean) => {
        const next = active === undefined ? !classes.has(cls) : active;
        if (next) classes.add(cls);
        else classes.delete(cls);
        return next;
      },
    };
  };

  const elements = new Map<string, {
    hidden: boolean;
    open?: boolean;
    scrollTop?: number;
    textContent?: string;
    className?: string;
    parentElement?: unknown;
    classList: ReturnType<typeof makeClassList>;
    querySelector?: (sel: string) => unknown;
  }>();
  const navButtons: Array<{ dataset: { page: string }; classList: { toggle: (cls: string, active: boolean) => void; contains: (cls: string) => boolean } }> = [];
  for (const page of ["overview", "sessions", "records", "settings"]) {
    elements.set(page, { hidden: page !== "overview", classList: makeClassList() });
    let isActive = false;
    navButtons.push({
      dataset: { page },
      classList: {
        toggle: (cls: string, active: boolean) => { if (cls === "active") isActive = active; },
        contains: (cls: string) => cls === "active" && isActive,
      },
    });
  }
  const sessionListEl = { scrollTop: 0, parentElement: elements.get("sessions"), classList: makeClassList() };
  const sessionToolbarEl = { scrollTop: 0, classList: makeClassList() };
  const messagesEl = { hidden: false, scrollTop: 0, classList: makeClassList() };
  const sendFormEl = { hidden: false, classList: makeClassList() };
  const sessionDetailEl = {
    hidden: false,
    parentElement: elements.get("sessions"),
    classList: makeClassList(),
    querySelector: (sel: string) => sel === ".session-toolbar" ? sessionToolbarEl : null,
  };
  (sessionToolbarEl as { parentElement?: unknown }).parentElement = sessionDetailEl;
  (messagesEl as { parentElement?: unknown }).parentElement = sessionDetailEl;
  (sendFormEl as { parentElement?: unknown }).parentElement = sessionDetailEl;
  elements.get("sessions")!.querySelector = (sel: string) => sel === ".session-list" ? sessionListEl : null;
  elements.set("console", { hidden: false, classList: makeClassList() });
  elements.set("session-detail", sessionDetailEl);
  elements.set("messages", messagesEl);
  elements.set("send-form", sendFormEl);
  elements.set("notice-bar", { hidden: true, className: "", classList: makeClassList() });
  elements.set("notice-text", { hidden: false, textContent: "", classList: makeClassList() });
  elements.set("notice-toggle", { hidden: true, textContent: "", classList: makeClassList() });
  elements.set("notice-retry", { hidden: true, textContent: "", classList: makeClassList() });
  elements.set("notice-close", { hidden: false, textContent: "", classList: makeClassList() });
  elements.set("login-notice", { hidden: false, textContent: "", classList: makeClassList() });
  const contentEl = { scrollTop: 0, classList: makeClassList() };
  const windowObj = { innerWidth: 390, innerHeight: 844 };

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelector: (sel: string) => sel === ".content" ? contentEl : null,
    querySelectorAll: (sel: string) => sel === "nav button" ? navButtons : [],
    hidden: false,
  };

  let refreshCalls = 0;
  let retryCalls = 0;
  const context = runInNewContext(
    script.slice(0, end) + `
    refresh = async () => { __onRefresh(); };
    retryConnection = () => { __onRetry(); };
    ({
      VALID_PAGES,
      pageFromPathname,
      readDefaultPagePreference,
      saveDefaultPagePreference,
      readRememberPathPreference,
      saveRememberPathPreference,
      readLastPage,
      saveLastPage,
      resolveInitialPage,
      showPage,
      closeSessionDetail,
      handlePopState,
      onMobileTouchStart,
      onMobileTouchMove,
      onMobileTouchEnd,
      onMobileTouchCancel,
      triggerPullRefresh,
      state,
    })
    `,
    {
      localStorage: storage,
      location,
      history,
      window: windowObj,
      document,
      URL,
      setTimeout,
      clearTimeout,
      __onRefresh: () => { refreshCalls++; },
      __onRetry: () => { retryCalls++; },
    }
  );

  return {
    ...context,
    storage,
    location,
    history,
    historyEntries,
    elements,
    navButtons,
    windowObj,
    sessionListEl,
    sessionToolbarEl,
    sessionDetailEl,
    messagesEl,
    sendFormEl,
    contentEl,
    get refreshCalls() { return refreshCalls; },
    get retryCalls() { return retryCalls; },
  };
}

test("pageFromPathname correctly parses known route segments and rejects unknown paths", async () => {
  const { pageFromPathname } = await loadRoutingHarness();
  expect(pageFromPathname("/overview")).toBe("overview");
  expect(pageFromPathname("/sessions")).toBe("sessions");
  expect(pageFromPathname("/records")).toBe("records");
  expect(pageFromPathname("/settings")).toBe("settings");
  expect(pageFromPathname("/sessions/")).toBe("sessions");
  expect(pageFromPathname("/")).toBeNull();
  expect(pageFromPathname("")).toBeNull();
  expect(pageFromPathname("/unknown-path")).toBeNull();
  expect(pageFromPathname("/api/sessions")).toBeNull();
});

test("default page preference defaults to overview, validates inputs and persists safely", async () => {
  const { readDefaultPagePreference, saveDefaultPagePreference } = await loadRoutingHarness();
  expect(readDefaultPagePreference()).toBe("overview");

  saveDefaultPagePreference("sessions");
  expect(readDefaultPagePreference()).toBe("sessions");

  saveDefaultPagePreference("invalid_page");
  expect(readDefaultPagePreference()).toBe("sessions");

  saveDefaultPagePreference("settings");
  expect(readDefaultPagePreference()).toBe("settings");
});

test("remember path preference defaults to true and toggles cleanly", async () => {
  const { readRememberPathPreference, saveRememberPathPreference } = await loadRoutingHarness();
  expect(readRememberPathPreference()).toBe(true);

  saveRememberPathPreference(false);
  expect(readRememberPathPreference()).toBe(false);

  saveRememberPathPreference(true);
  expect(readRememberPathPreference()).toBe(true);
});

test("last page tracker records valid visited pages and ignores invalid pages", async () => {
  const { readLastPage, saveLastPage } = await loadRoutingHarness();
  expect(readLastPage()).toBeNull();

  saveLastPage("records");
  expect(readLastPage()).toBe("records");

  saveLastPage("unknown_tab");
  expect(readLastPage()).toBe("records");

  saveLastPage("settings");
  expect(readLastPage()).toBe("settings");
});

test("resolveInitialPage prioritizes explicit direct route pathname over preferences", async () => {
  const storage = createStorage();
  storage.setItem("sea-default-page", "overview");
  storage.setItem("sea-last-page", "records");
  storage.setItem("sea-remember-path", "true");

  const { resolveInitialPage } = await loadRoutingHarness({ pathname: "/sessions", storage });
  const result = resolveInitialPage("/sessions");
  expect(result.page).toBe("sessions");
  expect(result.replaceUrl).toBe(false);
});

test("resolveInitialPage restores last visited page on root path when remember-path is enabled", async () => {
  const storage = createStorage();
  storage.setItem("sea-default-page", "overview");
  storage.setItem("sea-last-page", "records");
  storage.setItem("sea-remember-path", "true");

  const { resolveInitialPage } = await loadRoutingHarness({ pathname: "/", storage });
  const result = resolveInitialPage("/");
  expect(result.page).toBe("records");
  expect(result.replaceUrl).toBe(true);
});

test("resolveInitialPage uses default page preference when remember-path is disabled or absent", async () => {
  const storage = createStorage();
  storage.setItem("sea-default-page", "settings");
  storage.setItem("sea-last-page", "records");
  storage.setItem("sea-remember-path", "false");

  const { resolveInitialPage } = await loadRoutingHarness({ pathname: "/", storage });
  const result = resolveInitialPage("/");
  expect(result.page).toBe("settings");
  expect(result.replaceUrl).toBe(true);
});

test("showPage updates state, records last page, switches visibility, and updates browser history", async () => {
  const harness = await loadRoutingHarness({ pathname: "/overview" });
  await harness.showPage("sessions");

  expect(harness.state.page).toBe("sessions");
  expect(harness.readLastPage()).toBe("sessions");
  expect(harness.elements.get("sessions")?.hidden).toBe(false);
  expect(harness.elements.get("overview")?.hidden).toBe(true);
  expect(harness.location.pathname).toBe("/sessions");

  const lastEntry = harness.historyEntries.at(-1);
  expect(lastEntry?.url).toBe("/sessions");
  expect(lastEntry?.replace).toBe(false);

  await harness.showPage("records", { push: false });
  expect(harness.state.page).toBe("records");
  expect(harness.readLastPage()).toBe("records");
  const replaceEntry = harness.historyEntries.at(-1);
  expect(replaceEntry?.url).toBe("/records");
  expect(replaceEntry?.replace).toBe(true);
});

test("session detail open and close synchronize with browser history and popstate", async () => {
  const harness = await loadRoutingHarness({ pathname: "/sessions" });
  const sessionsEl = harness.elements.get("sessions")!;

  await harness.showPage("sessions", { push: false });
  expect(harness.state.detailOpen).toBe(false);

  // Entering session detail from the session list pushes a detail history state
  sessionsEl.classList.add("detail-open");
  await harness.showPage("sessions");
  expect(harness.state.detailOpen).toBe(true);
  expect(harness.state.detailHistoryPushed).toBe(true);
  expect(harness.historyEntries.at(-1)).toEqual({
    state: { page: "sessions", detailOpen: true },
    url: "/sessions",
    replace: false,
  });

  // Closing session detail returns to list and calls history.back()
  expect(harness.closeSessionDetail()).toBe(true);
  expect(sessionsEl.classList.contains("detail-open")).toBe(false);
  expect(harness.state.detailOpen).toBe(false);
  expect(harness.history.backCalls).toBe(1);

  // Entering session detail directly from overview pushes both list and detail history entries
  await harness.showPage("overview");
  sessionsEl.classList.add("detail-open");
  await harness.showPage("sessions");
  expect(harness.historyEntries.slice(-2)).toEqual([
    { state: { page: "sessions", detailOpen: false }, url: "/sessions", replace: false },
    { state: { page: "sessions", detailOpen: true }, url: "/sessions", replace: false },
  ]);

  // Browser back (popstate) to the list entry exits detail-open while staying on /sessions
  await harness.handlePopState({ state: { page: "sessions", detailOpen: false } });
  expect(harness.state.page).toBe("sessions");
  expect(harness.state.detailOpen).toBe(false);
  expect(sessionsEl.classList.contains("detail-open")).toBe(false);
});

test("mobile left-to-right swipe in session detail returns to session list and ignores non-eligible targets", async () => {
  const harness = await loadRoutingHarness({ pathname: "/sessions" });
  const sessionsEl = harness.elements.get("sessions")!;
  sessionsEl.classList.add("detail-open");
  await harness.showPage("sessions");

  // Left-to-right swipe inside messages returns to session list and syncs browser history
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 30, clientY: 200 }] }, 1000);
  harness.onMobileTouchMove({ touches: [{ clientX: 120, clientY: 210 }] });
  const outcome = harness.onMobileTouchEnd({ changedTouches: [{ clientX: 120, clientY: 210 }] }, 1250);
  expect(outcome).toBe("swipe-back");
  expect(sessionsEl.classList.contains("detail-open")).toBe(false);
  expect(harness.state.detailOpen).toBe(false);
  expect(harness.history.backCalls).toBe(1);

  // Re-open detail and verify right-to-left swipe does not exit detail
  sessionsEl.classList.add("detail-open");
  await harness.showPage("sessions");
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 200, clientY: 200 }] }, 2000);
  harness.onMobileTouchMove({ touches: [{ clientX: 100, clientY: 205 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 100, clientY: 205 }] }, 2200)).toBeNull();
  expect(sessionsEl.classList.contains("detail-open")).toBe(true);

  // Swiping inside a code block or textarea does not trigger swipe-back
  const codeBlock = { tagName: "PRE", className: "code-block", parentElement: harness.messagesEl };
  harness.onMobileTouchStart({ target: codeBlock, touches: [{ clientX: 30, clientY: 200 }] }, 3000);
  harness.onMobileTouchMove({ touches: [{ clientX: 130, clientY: 202 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 130, clientY: 202 }] }, 3200)).toBeNull();
  expect(sessionsEl.classList.contains("detail-open")).toBe(true);

  // Desktop viewport (>760px) ignores mobile swipe gestures
  harness.windowObj.innerWidth = 1024;
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 30, clientY: 200 }] }, 4000);
  harness.onMobileTouchMove({ touches: [{ clientX: 140, clientY: 205 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 140, clientY: 205 }] }, 4200)).toBeNull();
  expect(sessionsEl.classList.contains("detail-open")).toBe(true);
});

test("mobile top-to-bottom pull at top of scroller triggers refresh and ignores mid-scroll drags", async () => {
  const harness = await loadRoutingHarness({ pathname: "/sessions" });
  harness.state.paused = false;
  const sessionsEl = harness.elements.get("sessions")!;
  sessionsEl.classList.add("detail-open");
  await harness.showPage("sessions");
  const baselineRefreshes = harness.refreshCalls;

  // When messages scroller is not at the top (scrollTop > 0), downward drag scrolls normally without refreshing
  harness.messagesEl.scrollTop = 180;
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 180, clientY: 120 }] }, 1000);
  harness.onMobileTouchMove({ touches: [{ clientX: 182, clientY: 220 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 182, clientY: 220 }] }, 1300)).toBeNull();
  expect(harness.refreshCalls).toBe(baselineRefreshes);

  // When messages scroller is at the top (scrollTop === 0), downward pull triggers refresh
  harness.messagesEl.scrollTop = 0;
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 180, clientY: 120 }] }, 2000);
  harness.onMobileTouchMove({ touches: [{ clientX: 182, clientY: 210 }] });
  const pullOutcome = harness.onMobileTouchEnd({ changedTouches: [{ clientX: 182, clientY: 210 }] }, 2300);
  expect(pullOutcome).toBe("pull-refresh");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(harness.refreshCalls).toBe(baselineRefreshes + 1);
  expect(harness.elements.get("notice-text")?.textContent).toBe("已刷新");

  // Pulling down on session toolbar refreshes even when messages scroller is scrolled down
  harness.messagesEl.scrollTop = 320;
  harness.onMobileTouchStart({ target: harness.sessionToolbarEl, touches: [{ clientX: 180, clientY: 60 }] }, 3000);
  harness.onMobileTouchMove({ touches: [{ clientX: 180, clientY: 150 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 180, clientY: 150 }] }, 3300)).toBe("pull-refresh");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(harness.refreshCalls).toBe(baselineRefreshes + 2);

  // When disconnected (state.paused === true), pull-to-refresh triggers retryConnection()
  harness.state.paused = true;
  harness.messagesEl.scrollTop = 0;
  harness.onMobileTouchStart({ target: harness.messagesEl, touches: [{ clientX: 180, clientY: 100 }] }, 4000);
  harness.onMobileTouchMove({ touches: [{ clientX: 180, clientY: 190 }] });
  expect(harness.onMobileTouchEnd({ changedTouches: [{ clientX: 180, clientY: 190 }] }, 4300)).toBe("pull-refresh");
  expect(harness.retryCalls).toBe(1);
});

