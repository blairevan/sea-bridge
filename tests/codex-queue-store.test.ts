import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexQueueStore } from "../src/desktop/codex-queue-store.ts";

/** Model the observed native queue schema with a disposable real SQLite database. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "sea-queue-"));
  const path = join(root, "queue.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE queued_items(id TEXT PRIMARY KEY,thread_id TEXT,payload_json TEXT,queue_order INTEGER,created_at_ms INTEGER,updated_at_ms INTEGER)");
  /** Insert fixture text using the native UserInput envelope. */
  function insert(id: string, thread: string, order: number, text: string) {
    db.query("INSERT INTO queued_items VALUES(?,?,?,?,?,?)").run(id, thread,
      JSON.stringify({ UserInput: { content: [{ type: "text", text, text_elements: [] }], client_id: "fixture" } }), order, order * 100, order * 100);
  }
  /** Dispose only the explicitly created test directory. */
  function close() { db.close(); rmSync(root, { recursive: true, force: true }); }
  return { root, path, db, insert, close };
}

test("native queue preserves its order, isolates threads and observes edits and consumption", () => {
  const f = fixture();
  try {
    f.insert("b", "thread", 2, "second"); f.insert("a", "thread", 1, "first"); f.insert("other", "elsewhere", 0, "hidden");
    const store = new CodexQueueStore(f.path);
    expect(store.read("thread")).toEqual({ available: true, messages: [
      { id: "queued-a", role: "user", text: "first", createdAt: 100, deliveryState: "queued" },
      { id: "queued-b", role: "user", text: "second", createdAt: 200, deliveryState: "queued" },
    ] });
    f.db.query("UPDATE queued_items SET payload_json=? WHERE id='b'").run(JSON.stringify({ UserInput: { content: [{ type: "text", text: "edited" }] } }));
    f.db.query("DELETE FROM queued_items WHERE id='a'").run();
    expect(store.read("thread").messages.map((message) => message.text)).toEqual(["edited"]);
    expect(f.db.query("SELECT count(*) AS total FROM queued_items").get()).toEqual({ total: 2 });
  } finally { f.close(); }
});

test("missing and malformed queues remain unavailable and are never created", () => {
  const f = fixture();
  try {
    const missing = join(f.root, "absent.sqlite");
    expect(new CodexQueueStore(missing).read("thread")).toEqual({ available: false, messages: [] });
    expect(existsSync(missing)).toBe(false);
    f.db.query("INSERT INTO queued_items VALUES('bad','thread','{',0,0,0)").run();
    expect(new CodexQueueStore(f.path).read("thread")).toEqual({ available: false, messages: [] });
  } finally { f.close(); }
});

test("empty queue is confirmed and non-user payloads never become user bubbles", () => {
  const f = fixture();
  try {
    f.db.query("INSERT INTO queued_items VALUES('other','thread',?,0,0,0)").run(JSON.stringify({ OtherInput: { text: "not a user prompt" } }));
    expect(new CodexQueueStore(f.path).read("thread")).toEqual({ available: true, messages: [] });
  } finally { f.close(); }
});

test("queue reader refuses symlink paths", () => {
  const f = fixture();
  try {
    const link = join(f.root, "link.sqlite"); symlinkSync(f.path, link);
    expect(new CodexQueueStore(link).read("thread")).toEqual({ available: false, messages: [] });
  } finally { f.close(); }
});

test("diagnostic metadata survives malformed payloads without returning message content", () => {
  const f = fixture();
  try {
    f.insert("a", "thread", 1, "private body");
    f.db.query("INSERT INTO queued_items VALUES('bad','thread','{',2,200,200)").run();
    const store = new CodexQueueStore(f.path);
    expect(store).toHaveProperty("readMetadata");
    const snapshot = store.readMetadata(1);
    expect(snapshot).toMatchObject({ available: true, truncated: true, items: [
      { id: "a", threadId: "thread", createdAt: 100, updatedAt: 100, clientId: null, queueOrder: 1 },
    ] });
    expect(JSON.stringify(snapshot)).not.toContain("private body");
    expect(store.readMetadata(10).items.map((item) => item.id)).toEqual(["a", "bad"]);
    expect(new CodexQueueStore(join(f.root, "missing.sqlite")).readMetadata()).toMatchObject({ available: false, errorCode: "queue_missing" });
  } finally { f.close(); }
});
