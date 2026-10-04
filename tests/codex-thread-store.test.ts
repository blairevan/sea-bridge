import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexThreadStore } from "../src/desktop/codex-thread-store.ts";

/** Create a minimal copy of the verified native thread schema without touching Codex data. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-thread-list-")); const path = join(root, "state.sqlite");
  const db = new Database(path);
  db.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT,name TEXT,title TEXT,recency_at_ms INTEGER,archived INTEGER,thread_source TEXT)");
  return { root, db, store: new CodexThreadStore(path) };
}

test("active list excludes named and unnamed subagents but retains ordinary untitled threads", () => {
  const { root, db, store } = fixture();
  try {
    const insert = db.query("INSERT INTO threads VALUES(?,?,?,?,?,?,?)");
    insert.run("ordinary", "/fixture/ordinary", "正式名称", "原始标题", 1, 0, "cli");
    insert.run("subagent-empty", "/fixture/subagent-empty", "", "", 2, 0, "subagent");
    insert.run("subagent-named", "/fixture/subagent-named", "内部审查", "审查", 3, 0, "subagent");
    insert.run("ordinary-empty", "/fixture/ordinary-empty", "", "", 4, 0, null);
    insert.run("archived", "/fixture/archived", "已归档", "标题", 5, 1, "cli");
    const items = store.listActive();
    expect(items.map((item) => item.id)).toEqual(["ordinary", "ordinary-empty"]);
    expect(items[0]?.title).toBe("正式名称");
    expect(items[1]?.title).toBe("未命名会话 · ry-empty");
    // Diagnostic point lookups retain access to internal records.
    expect(store.getThread("subagent-named")?.title).toBe("内部审查");
    expect(db.query("SELECT count(*) AS count FROM threads").get()).toEqual({ count: 5 });
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("list and point lookup share trimmed name, title and short identity fallbacks", () => {
  const { root, db, store } = fixture();
  try {
    const insert = db.query("INSERT INTO threads VALUES(?,?,?,?,?,0,'cli')");
    insert.run("name", "/fixture/name", "  名称  ", "标题", 1);
    insert.run("title", "/fixture/title", " \t ", "  标题  ", 2);
    insert.run("01a0fd67-0000-0000-0000-123456789abc", "/fixture/blank", null, " \n ", 3);
    const items = store.listActive();
    expect(items.map((item) => item.title)).toEqual(["名称", "标题", "未命名会话 · 56789abc"]);
    for (const item of items) expect(store.getThread(item.id)?.title).toBe(item.title);
    expect(store.getThread("missing")).toBeNull();
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
