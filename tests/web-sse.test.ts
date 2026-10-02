import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";

test("SSE sends version-only controls and revocation closes the device stream", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const auth = new WebAuth(store);
  const paired = auth.pair(auth.createPairCode().code, "local", "fixture"); if (!paired) throw new Error("fixture failed");
  const events = new WebEvents(store);
  const stream = events.open(paired.device.id, new AbortController().signal);
  const reader = stream.getReader(); await reader.read();
  events.settingsChanged(2);
  const update = new TextDecoder().decode((await reader.read()).value);
  expect(update).toContain("settings_version"); expect(update).toContain('"version":2'); expect(update).not.toContain("fixture");
  events.revoke(paired.device.id);
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("session_revoked");
  expect((await reader.read()).done).toBe(true);
  events.close(); db.close();
});
