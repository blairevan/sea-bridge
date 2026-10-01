import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { StateDb } from "../src/state/db.ts";
import { DshBridgeStore } from "../src/state/dsh-bridge-store.ts";
import { DshSessionObserver } from "../src/dsh/session-observer.ts";

const ENV_KEYS = [
  "TELEGRAM_BOT_TOKEN",
  "ALLOWED_USER_ID",
  "ALLOWED_CHAT_ID",
  "SEA_BRIDGE_DB_PATH",
  "SEA_BRIDGE_HOOK_SOCKET",
  "SEA_BRIDGE_CODEX_STATE_DB_PATH",
  "SEA_BRIDGE_CODEX_THREAD_HISTORY_DB_PATH",
  "SEA_BRIDGE_CODEX_CLI_PATH",
  "CODEX_HOME",
  "SEA_BRIDGE_DSH_READ_ONLY_ENABLED",
  "SEA_BRIDGE_DSH_WRITE_ENABLED",
  "SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED",
  "SEA_BRIDGE_DSH_SOCKET_PATH",
  "SEA_BRIDGE_DSH_TOKEN_PATH",
  "SEA_BRIDGE_DSH_POLL_INTERVAL_MS",
] as const;

const original = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = original.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function baseEnv(root: string): void {
  process.env.TELEGRAM_BOT_TOKEN = "test-token";
  process.env.ALLOWED_USER_ID = "123";
  process.env.ALLOWED_CHAT_ID = "456";
  process.env.SEA_BRIDGE_DB_PATH = join(root, "state.sqlite3");
  process.env.SEA_BRIDGE_HOOK_SOCKET = join(root, "hook.sock");
  process.env.SEA_BRIDGE_CODEX_STATE_DB_PATH = join(root, "codex-state.sqlite3");
  process.env.SEA_BRIDGE_CODEX_THREAD_HISTORY_DB_PATH = join(root, "codex-history.sqlite3");
  process.env.SEA_BRIDGE_CODEX_CLI_PATH = "/bin/true";
  process.env.CODEX_HOME = root;
  process.env.SEA_BRIDGE_DSH_SOCKET_PATH = join(root, "dsh.sock");
  process.env.SEA_BRIDGE_DSH_TOKEN_PATH = join(root, "dsh.token");
}

describe("dsh lifecycle configuration", () => {
  test("defaults to ten-second fallback scanning without an override", () => {
    const root = mkdtempSync(join(tmpdir(), "sea-bridge-dsh-config-"));
    try {
      baseEnv(root);
      delete process.env.SEA_BRIDGE_DSH_POLL_INTERVAL_MS;
      expect(loadConfig().dshPollIntervalMs).toBe(10_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("write and notifications cannot be enabled without the read transport", () => {
    const root = mkdtempSync(join(tmpdir(), "sea-bridge-dsh-config-"));
    try {
      baseEnv(root);
      process.env.SEA_BRIDGE_DSH_READ_ONLY_ENABLED = "false";
      process.env.SEA_BRIDGE_DSH_WRITE_ENABLED = "true";
      expect(() => loadConfig()).toThrow("SEA_BRIDGE_DSH_WRITE_ENABLED requires SEA_BRIDGE_DSH_READ_ONLY_ENABLED");

      process.env.SEA_BRIDGE_DSH_WRITE_ENABLED = "false";
      process.env.SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED = "true";
      expect(() => loadConfig()).toThrow("SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED requires SEA_BRIDGE_DSH_READ_ONLY_ENABLED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("full mode parses independently from Codex settings", () => {
    const root = mkdtempSync(join(tmpdir(), "sea-bridge-dsh-config-"));
    try {
      baseEnv(root);
      process.env.SEA_BRIDGE_DSH_READ_ONLY_ENABLED = "true";
      process.env.SEA_BRIDGE_DSH_WRITE_ENABLED = "true";
      process.env.SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED = "true";
      process.env.SEA_BRIDGE_DSH_POLL_INTERVAL_MS = "4321";
      const config = loadConfig();
      expect(config.dshReadOnlyEnabled).toBe(true);
      expect(config.dshWriteEnabled).toBe(true);
      expect(config.dshNotificationsEnabled).toBe(true);
      expect(config.dshPollIntervalMs).toBe(4321);
      expect(config.dshSocketPath).toBe(join(root, "dsh.sock"));
      expect(config.dshTokenPath).toBe(join(root, "dsh.token"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("dsh observer fail-soft lifecycle", () => {
  test("scheduled Host failure is contained and stop remains bounded", async () => {
    const state = new StateDb(":memory:");
    const store = new DshBridgeStore(state);
    let calls = 0;
    const host = {
      health: async () => {
        calls++;
        throw Object.assign(new Error("offline"), { code: "host_unavailable" });
      },
      listSessions: async () => [],
      followSnapshot: async () => ({ cursor: -1, hasMore: false, truncated: false, events: [] }),
      pageHistory: async () => ({ hasMore: false, truncated: false, events: [] }),
    };
    const observer = new DshSessionObserver(
      host as any,
      store,
      { sendMessage: async () => ({ message_id: 1 }) },
      "456",
      60_000,
      true,
      () => 0.5,
    );
    try {
      observer.start();
      for (let index = 0; index < 20 && calls === 0; index++) await Bun.sleep(5);
      for (let index = 0; index < 20 && observer.getStatus().lastErrorCode === null; index++) await Bun.sleep(5);
      expect(calls).toBeGreaterThan(0);
      expect(observer.getStatus()).toMatchObject({
        running: true,
        lastErrorCode: "host_unavailable",
        consecutiveFailures: 1,
      });
      expect(observer.getStatus().nextPollAt).toBeNumber();
      expect((observer as any).retryDelayMs(1)).toBe(60_000);
      expect((observer as any).retryDelayMs(2)).toBe(120_000);
      expect((observer as any).retryDelayMs(4)).toBe(300_000);
      await observer.stop();
      expect(observer.getStatus()).toMatchObject({
        running: false,
        nextPollAt: null,
      });
    } finally {
      await observer.stop();
      state.close();
    }
  });
});
