import type { WebSource } from "./sources/types.ts";

/** Read-only receive-poll evidence; no Telegram payload or identity is exposed. */
export interface TelegramStatus { stopped: boolean; lastPollSuccessAt: number | null; pollFailed: boolean; }

/** Coalesce source availability sampling; browsing status never starts a CLI version probe. */
export function createStatusService(sources: Partial<Record<"codex" | "dsh", WebSource>>, telegram: () => TelegramStatus) {
  let cached: { sources: Record<string, unknown>; observedAt: number } | null = null;
  let until = 0;
  let pending: Promise<void> | null = null;
  /** Return bounded capability evidence plus the current Telegram polling projection. */
  return async () => {
    if (!cached || until <= Date.now()) {
      pending ??= (async () => {
        const statuses: Record<string, unknown> = {};
        await Promise.all(Object.entries(sources).map(async ([name, source]) => {
          if (!source) return;
          try { await source.sessions(); statuses[name] = { state: "limited", capabilities: source.capabilities() }; }
          catch { statuses[name] = { state: "unavailable", capabilities: source.capabilities() }; }
        }));
        cached = { sources: statuses, observedAt: Date.now() }; until = Date.now() + 30000;
      })();
      try { await pending; } finally { pending = null; }
    }
    return { ...cached, telegram: telegram() };
  };
}
