import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";
import { CodexObserverStore } from "../src/state/codex-observer-store.ts";
import { resetCodexObserver } from "../scripts/codex-observer-reset.ts";

function withDb(run: (path: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "codex-observer-reset-"));
  try { run(join(root, "state.sqlite")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

describe("codex observer reset", () => {
  test("same CODEX_HOME resets observer/catalog but preserves old reply links", () => withDb((path) => {
    const state = new StateDb(path);
    new CodexObserverStore(state, "/home/a").ensureEnvironment(1);
    state.db.query("INSERT INTO desktop_message_links VALUES('42',1,'thread','turn','completed','fp',1)").run();
    state.db.query("INSERT INTO desktop_codex_catalog_meta VALUES(1,'/home/a',1,1,'full',1)").run();
    state.close();

    expect(resetCodexObserver(path, "/home/a")).toMatchObject({ replyLinksCleared: false });
    const reopened = new StateDb(path);
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM desktop_message_links").get()).toEqual({ count: 1 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM desktop_codex_catalog_meta").get()).toEqual({ count: 0 });
    expect(reopened.db.query("SELECT codex_home_identity FROM desktop_observer_meta").get()).toEqual({ codex_home_identity: "/home/a" });
    reopened.close();
  }));

  test("CODEX_HOME switch clears old Codex reply and temporary environment state", () => withDb((path) => {
    const state = new StateDb(path);
    new CodexObserverStore(state, "/home/a").ensureEnvironment(1);
    state.db.query("INSERT INTO desktop_message_links VALUES('42',1,'thread','turn','completed','fp',1)").run();
    state.db.query(`
      INSERT INTO desktop_notification_outbox(
        event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
        attempt_count,next_attempt_at,telegram_message_id,created_at,updated_at
      ) VALUES('fp-sent','42','thread','turn','completed','done','sent',0,1,1,1,1)
    `).run();
    state.db.query(`INSERT INTO pending_new_thread_prompts(
      telegram_chat_id,prompt_message_id,project_id,project_name,cwd,created_at,expires_at,status
    ) VALUES('42',7,'project','Project','/old',1,999999,'pending')`).run();
    state.db.query("INSERT INTO user_preferences VALUES('42','default_model','old-model',1)").run();
    state.close();

    expect(resetCodexObserver(path, "/home/b")).toMatchObject({
      environmentChanged: true,
      replyLinksCleared: true,
      notificationHistoryCleared: true,
      pendingPromptsCleared: true,
      modelPreferenceCleared: true,
    });
    const reopened = new StateDb(path);
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM desktop_message_links").get()).toEqual({ count: 0 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM desktop_notification_outbox").get()).toEqual({ count: 0 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM pending_new_thread_prompts").get()).toEqual({ count: 0 });
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM user_preferences WHERE key='default_model'").get()).toEqual({ count: 0 });
    expect(reopened.db.query("SELECT codex_home_identity FROM desktop_observer_meta").get()).toEqual({ codex_home_identity: "/home/b" });
    reopened.close();
  }));

  test("same CODEX_HOME reset preserves a pending Codex outbox notification", () => withDb((path) => {
    const state = new StateDb(path);
    new CodexObserverStore(state, "/home/a").ensureEnvironment(1);
    state.db.query(`
      INSERT INTO desktop_notification_outbox(
        event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
        attempt_count,next_attempt_at,created_at,updated_at
      ) VALUES('fp-same','42','thread','turn','completed','done','pending',0,1,1,1)
    `).run();
    state.close();

    expect(resetCodexObserver(path, "/home/a")).toMatchObject({ environmentChanged: false, notificationHistoryCleared: false });
    const reopened = new StateDb(path);
    expect(reopened.db.query("SELECT COUNT(*) AS count FROM desktop_notification_outbox WHERE status='pending'").get()).toEqual({ count: 1 });
    reopened.close();
  }));

  test("refuses CODEX_HOME switch while a Codex outbox notification is pending", () => withDb((path) => {
    const state = new StateDb(path);
    new CodexObserverStore(state, "/home/a").ensureEnvironment(1);
    state.db.query(`
      INSERT INTO desktop_notification_outbox(
        event_fingerprint,telegram_chat_id,thread_id,turn_id,event_kind,message_text,status,
        attempt_count,next_attempt_at,created_at,updated_at
      ) VALUES('fp','42','thread','turn','completed','done','pending',0,1,1,1)
    `).run();
    state.close();

    expect(() => resetCodexObserver(path, "/home/b")).toThrow("codex_notifications_pending:1");
    const reopened = new StateDb(path);
    expect(reopened.db.query("SELECT codex_home_identity FROM desktop_observer_meta").get()).toEqual({ codex_home_identity: "/home/a" });
    reopened.close();
  }));
});
