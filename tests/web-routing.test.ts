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
  const history = {
    pushState: (state: unknown, _title: string, url: string) => {
      historyEntries.push({ state, url, replace: false });
      location.pathname = url;
    },
    replaceState: (state: unknown, _title: string, url: string) => {
      historyEntries.push({ state, url, replace: true });
      location.pathname = url;
    },
  };

  const elements = new Map<string, { hidden: boolean; classList: { toggle: (cls: string, active: boolean) => void } }>();
  const navButtons: Array<{ dataset: { page: string }; classList: { toggle: (cls: string, active: boolean) => void; contains: (cls: string) => boolean } }> = [];
  for (const page of ["overview", "sessions", "records", "settings"]) {
    elements.set(page, { hidden: page !== "overview", classList: { toggle() {} } });
    let isActive = false;
    navButtons.push({
      dataset: { page },
      classList: {
        toggle: (cls: string, active: boolean) => { if (cls === "active") isActive = active; },
        contains: (cls: string) => cls === "active" && isActive,
      },
    });
  }

  const document = {
    getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: (sel: string) => sel === "nav button" ? navButtons : [],
    hidden: false,
  };

  const context = runInNewContext(
    script.slice(0, end) + `
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
      state,
    })
    `,
    {
      localStorage: storage,
      location,
      history,
      document,
      URL,
      setTimeout,
      clearTimeout,
    }
  );

  return { ...context, storage, location, history, historyEntries, elements, navButtons };
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

