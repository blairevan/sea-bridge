import { LOGIN_FIXTURE, LOGIN_HASH, loginFixture } from "./helpers/web-login.ts";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebEvents } from "../src/web/events.ts";

test("heartbeat buffering closes a slow client within the same event bound", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const auth = new WebAuth(store);
  const paired = await loginFixture(auth); if (!paired) throw new Error("fixture failed");
  let tick: (() => void) | undefined;
  const events = new WebEvents(store, (callback) => { tick = callback; return setInterval(() => {}, 15000); });
  try {
    const reader = events.open(paired.device.id, new AbortController().signal).getReader();
    for (let index = 0; index < 100; index++) tick?.();
    events.close(); let chunks = 0;
    while (!(await reader.read()).done) chunks++;
    expect(chunks).toBeLessThanOrEqual(18);
  } finally { events.close(); db.close(); }
});

test("SSE sends version-only controls and revocation closes the device stream", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const auth = new WebAuth(store);
  const paired = await loginFixture(auth); if (!paired) throw new Error("fixture failed");
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

test("SSE recovery notice contains only outcome metadata and the current policy version", async () => {
  const db = new Database(":memory:"); migrateWeb(db); const store = new WebStore(db); const auth = new WebAuth(store);
  const paired = await loginFixture(auth); if (!paired) throw new Error("fixture failed");
  const events = new WebEvents(store);
  try {
    const reader = events.open(paired.device.id, new AbortController().signal).getReader();
    await reader.read();
    events.desktopRecovery({ threadId: "11111111-1111-4111-8111-111111111111", outcome: "open_requested", occurredAt: 123 });
    const update = new TextDecoder().decode((await reader.read()).value);
    expect(update).toContain("event: desktop_recovery");
    const line = update.split("\n").find((value) => value.startsWith("data: "));
    expect(JSON.parse(line?.slice(6) ?? "{}")).toEqual({ threadId: "11111111-1111-4111-8111-111111111111", outcome: "open_requested", occurredAt: 123, version: store.getSettings().version });
    store.revokeDevice(paired.device.id, Date.now());
    events.desktopRecovery({ threadId: "11111111-1111-4111-8111-111111111111", outcome: "failed", occurredAt: 124 });
    expect(new TextDecoder().decode((await reader.read()).value)).toContain("session_revoked");
    expect((await reader.read()).done).toBe(true);
  } finally { events.close(); db.close(); }
});
