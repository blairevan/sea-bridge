import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { StateDb } from "../src/state/db.ts";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { operationRecords } from "../src/web/records.ts";

test("operation filters are applied before bounded provider queries", () => {
  const db = new Database(":memory:"); migrateWeb(db);
  const store = new WebStore(db);
  for (let index = 0; index < 12; index++) {
    store.claimOperation({ id: `codex-${index}`, digest: `c-${index}`, kind: "send", source: "codex", deviceId: "device",
      targetId: "thread", projectId: null, modelId: null, createdAt: 100 - index });
  }
  store.claimOperation({ id: "dsh-old", digest: "d", kind: "send", source: "dsh", deviceId: "device",
    targetId: "session", projectId: null, modelId: null, createdAt: 1 });

  const result = operationRecords(store, { source: "dsh", session: null, state: null, from: 0, to: 1000, limit: 10, offset: 0 });
  expect(result.items.map((item) => item.id)).toEqual(["dsh-old"]);
  db.close();
});

test("Telegram delivered states map to provider-specific Web states before filtering", () => {
  const state = new StateDb(":memory:"); migrateWeb(state.db);
  const store = new WebStore(state.db);
  state.db.query("INSERT INTO telegram_thread_deliveries(telegram_update_id,reply_to_message_id,thread_id,text_hash,status,error_code,created_at,completed_at) VALUES(1,1,'thread','x','delivered',NULL,10,11)").run();
  state.db.query("INSERT INTO dsh_deliveries(telegram_update_id,reply_to_message_id,session_id,text_hash,status,error_code,created_at,completed_at) VALUES(2,1,'session','x','delivered',NULL,9,10)").run();
  state.db.query("INSERT INTO dsh_creation_requests(telegram_update_id,project_id,model_id,prompt_hash,status,session_id,turn_id,error_code,created_at,updated_at) VALUES(3,'project',NULL,'x','acknowledged','created-session',NULL,NULL,8,9)").run();

  expect(operationRecords(store, { source: "codex", session: null, state: "queued", from: 0, to: 100, limit: 10, offset: 0 }).items)
    .toMatchObject([{ source: "codex", transport: "telegram", state: "queued" }]);
  expect(operationRecords(store, { source: "dsh", session: null, state: "accepted", from: 0, to: 100, limit: 10, offset: 0 }).items)
    .toMatchObject([
      { source: "dsh", transport: "telegram", kind: "send", state: "accepted" },
      { source: "dsh", transport: "telegram", kind: "create", state: "accepted", sessionId: "created-session" },
    ]);
  expect(operationRecords(store, { source: "codex", session: null, state: "accepted", from: 0, to: 100, limit: 10, offset: 0 }).items).toEqual([]);
  state.close();
});
