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
          try {
            if (source.probeCapabilities) await source.probeCapabilities();
            else await source.sessions();
            statuses[name] = { state: source.statusState?.() ?? "limited", capabilities: source.capabilities(), details: source.statusDetails?.() };
          } catch {
            const projected = source.statusState?.();
            statuses[name] = {
              state: projected && projected !== "limited" ? projected : "unavailable",
              capabilities: source.capabilities(),
              details: source.statusDetails?.(),
            };
          }
        }));
        cached = { sources: statuses, observedAt: Date.now() };
        const degraded = Object.values(statuses).some((value) => {
          const state = (value as { state?: string }).state;
          return state !== "limited";
        });
        until = Date.now() + (degraded ? 3000 : 30000);
      })();
      try { await pending; } finally { pending = null; }
    }
    return { ...cached, telegram: telegram() };
  };
}
