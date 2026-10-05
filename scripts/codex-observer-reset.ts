import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { CODEX_OBSERVER_SCHEMA_VERSION } from "../src/state/codex-observer-store.ts";

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return resolve(value);
}

export interface CodexObserverResetResult {
  codexHome: string;
  observerReset: true;
  catalogReset: true;
  environmentChanged: boolean;
  replyLinksCleared: boolean;
  notificationHistoryCleared: boolean;
  pendingPromptsCleared: boolean;
  modelPreferenceCleared: boolean;
}

export function resetCodexObserver(dbPath: string, codexHome: string): CodexObserverResetResult {
  const resolvedDbPath = expandHome(dbPath);
  const resolvedCodexHome = expandHome(codexHome);
  if (!existsSync(resolvedDbPath)) throw new Error(`state_db_missing:${resolvedDbPath}`);

  const state = new StateDb(resolvedDbPath);
  try {
    const previous = state.db.query(
      "SELECT codex_home_identity FROM desktop_observer_meta WHERE singleton_id=1",
    ).get() as { codex_home_identity: string } | null;
    const identity = resolve(resolvedCodexHome);
    const environmentChanged = previous !== null && previous.codex_home_identity !== identity;
    if (environmentChanged) {
      const pending = state.db.query(
        "SELECT COUNT(*) AS count FROM desktop_notification_outbox WHERE status='pending'",
      ).get() as { count: number };
      if (Number(pending.count) > 0) throw new Error(`codex_notifications_pending:${pending.count}`);
    }
    const now = Date.now();

    state.db.transaction(() => {
      if (environmentChanged) {
        state.db.run("DELETE FROM desktop_message_links");
        state.db.run("DELETE FROM desktop_notification_outbox");
        state.db.run("DELETE FROM pending_new_thread_prompts");
        state.db.query("DELETE FROM user_preferences WHERE key='default_model'").run();
      }
      state.db.run("DELETE FROM desktop_codex_catalog");
      state.db.run("DELETE FROM desktop_codex_catalog_meta");
      state.db.run("DELETE FROM desktop_turn_observations");
      state.db.run("DELETE FROM desktop_observer_state");
      state.db.run("DELETE FROM desktop_observer_meta");
      state.db.query(`
        INSERT INTO desktop_observer_meta(singleton_id,schema_version,schema_initialized_at,codex_home_identity)
        VALUES(1,?,?,?)
      `).run(CODEX_OBSERVER_SCHEMA_VERSION, now, identity);
    })();

    return {
      codexHome: resolvedCodexHome,
      observerReset: true,
      catalogReset: true,
      environmentChanged,
      replyLinksCleared: environmentChanged,
      notificationHistoryCleared: environmentChanged,
      pendingPromptsCleared: environmentChanged,
      modelPreferenceCleared: environmentChanged,
    };
  } finally {
    state.close();
  }
}

if (import.meta.main) {
  const dbPath = process.env.SEA_BRIDGE_DB_PATH ?? "~/Library/Application Support/SeaBridge/sea-bridge.sqlite3";
  const codexHome = process.env.CODEX_HOME ?? "~/.codex";
  try {
    const result = resetCodexObserver(dbPath, codexHome);
    console.log(JSON.stringify({
      ok: true,
      ...result,
      note: "Restart Sea-Bridge to rebuild the Codex catalog and observer baseline.",
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("state_db_missing:")) process.exitCode = 2;
    else if (message.startsWith("codex_notifications_pending:")) process.exitCode = 3;
    else process.exitCode = 1;
    console.error(message);
  }
}
