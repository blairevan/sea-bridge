import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("syncViewport ignores messages and does not scroll when active page is overview or settings", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const properties = new Map<string, string>();

  const window = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0, scale: 1 } };
  const document = {
    activeElement: {},
    getElementById: (id: string) => {
      if (id === "sessions") return { hidden: true };
      if (id === "messages") {
        return {
          scrollHeight: 0,
          clientHeight: 0,
          scrollTop: 0
        };
      }
      return null;
    },
    documentElement: {
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
      classList: { toggle: () => {} }
    }
  };

  const context = {
    window,
    document,
    scrollMessagesCalled: false
  };

  const ui = runInNewContext(
    script.slice(0, end) +
      '\nscrollMessagesToLatest = () => { scrollMessagesCalled = true; }; ({ state, syncViewport })',
    context
  ) as { state: { page: string; paused: boolean }; syncViewport: () => void };

  ui.state.page = "overview";
  ui.state.paused = false;
  ui.syncViewport();
  expect(context.scrollMessagesCalled).toBe(false);

  ui.state.page = "settings";
  ui.syncViewport();
  expect(context.scrollMessagesCalled).toBe(false);

  ui.state.page = "records";
  ui.syncViewport();
  expect(context.scrollMessagesCalled).toBe(false);
});

test("syncViewport scrolls messages only when in sessions page with visible messages container", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const end = script.indexOf('\ndocument.querySelectorAll("nav button").forEach');
  const properties = new Map<string, string>();

  const window = { innerWidth: 390, innerHeight: 844, visualViewport: { height: 844, offsetTop: 0, scale: 1 } };
  const document = {
    activeElement: {},
    getElementById: (id: string) => {
      if (id === "sessions") return { hidden: false };
      if (id === "messages") {
        return {
          scrollHeight: 1000,
          clientHeight: 500,
          scrollTop: 450
        };
      }
      return null;
    },
    documentElement: {
      style: { setProperty: (key: string, value: string) => properties.set(key, value) },
      classList: { toggle: () => {} }
    }
  };

  const context = {
    window,
    document,
    scrollMessagesCalled: false
  };

  const ui = runInNewContext(
    script.slice(0, end) +
      '\nscrollMessagesToLatest = () => { scrollMessagesCalled = true; }; ({ state, syncViewport })',
    context
  ) as { state: { page: string; paused: boolean }; syncViewport: () => void };

  ui.state.page = "sessions";
  ui.state.paused = false;
  ui.syncViewport();
  expect(context.scrollMessagesCalled).toBe(true);
});

test("visualViewport scroll event listener is not registered to avoid dragging interference", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  expect(script).not.toContain('visualViewport?.addEventListener("scroll"');
  expect(script).not.toContain("visualViewport.addEventListener('scroll'");
  expect(script).not.toContain('visualViewport.addEventListener("scroll"');
});

