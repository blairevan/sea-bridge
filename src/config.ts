import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { existsSync, mkdirSync } from "node:fs";

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export interface AppConfig {
  telegramBotToken: string;
  allowedUserId: string;
  allowedChatId: string;
  dbPath: string;
  hookSocketPath: string;
  approvalTimeoutMs: number;
  activeSessionTtlMs: number;
  codexStateDbPath: string;
  codexThreadHistoryDbPath: string;
  codexCliPath: string;
  desktopPollIntervalMs: number;
  telegramSummaryMaxChars: number;
  logLevel: "debug" | "info" | "warn" | "error";
  codexHome: string;
}

export function loadConfig(): AppConfig {
  const dbPath = expandHome(process.env.SEA_BRIDGE_DB_PATH ?? "~/Library/Application Support/SeaBridge/sea-bridge.sqlite3");
  const hookSocketPath = expandHome(process.env.SEA_BRIDGE_HOOK_SOCKET ?? "~/Library/Application Support/SeaBridge/run/codex-hook.sock");
  const codexStateDbPath = expandHome(process.env.SEA_BRIDGE_CODEX_STATE_DB_PATH ?? "~/.codex/state_5.sqlite");
  const codexThreadHistoryDbPath = expandHome(process.env.SEA_BRIDGE_CODEX_THREAD_HISTORY_DB_PATH ?? "~/.codex/thread_history_1.sqlite");
  const defaultCodexCliPaths = [
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ];
  const detectedDefaultCliPath = defaultCodexCliPaths.find((p) => existsSync(p)) ?? defaultCodexCliPaths[0];
  const codexCliPath = expandHome(process.env.SEA_BRIDGE_CODEX_CLI_PATH ?? detectedDefaultCliPath);
  const codexHome = expandHome(process.env.CODEX_HOME ?? dirname(codexStateDbPath));
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(hookSocketPath), { recursive: true, mode: 0o700 });

  const rawLevel = (process.env.SEA_BRIDGE_LOG_LEVEL ?? "info") as AppConfig["logLevel"];
  const logLevel: AppConfig["logLevel"] = ["debug", "info", "warn", "error"].includes(rawLevel) ? rawLevel : "info";

  return {
    telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
    allowedUserId: required("ALLOWED_USER_ID"),
    allowedChatId: required("ALLOWED_CHAT_ID"),
    dbPath,
    hookSocketPath,
    approvalTimeoutMs: positiveInt("SEA_BRIDGE_APPROVAL_TIMEOUT_MS", 25_000),
    activeSessionTtlMs: positiveInt("SEA_BRIDGE_ACTIVE_SESSION_TTL_MS", 10 * 60_000),
    codexStateDbPath,
    codexThreadHistoryDbPath,
    codexCliPath,
    desktopPollIntervalMs: positiveInt("SEA_BRIDGE_DESKTOP_POLL_INTERVAL_MS", 2_000),
    telegramSummaryMaxChars: positiveInt("SEA_BRIDGE_TELEGRAM_SUMMARY_MAX_CHARS", 3_000),
    logLevel,
    codexHome,
  };
}
