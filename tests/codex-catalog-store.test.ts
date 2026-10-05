import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { CodexCatalogStore } from "../src/desktop/codex-catalog-store.ts";
import type { CodexReadThread } from "../src/desktop/codex-read-service.ts";

function item(id: string, updatedAtMs: number): CodexReadThread {
  return {
    id,
    title: `title-${id}`,
    rolloutPath: `/tmp/${id}.jsonl`,
    createdAtMs: 1,
    updatedAtMs,
    recencyAtMs: updatedAtMs,
    source: "cli",
    originator: "codex-tui",
    parentThreadId: null,
    threadSource: "user",
    creationClient: { kind: "cli", evidence: "originator" },
  };
}

describe("CodexCatalogStore", () => {
  test("commits full snapshots and only removes a missing thread after two full scans", () => {
    const state = new StateDb(":memory:");
    const store = new CodexCatalogStore(state, "/home/codex");
    store.commitFull([item("a", 10), item("b", 20)], 100);
    expect(store.listActive().map((thread) => thread.id)).toEqual(["b", "a"]);

    store.commitFull([item("b", 30)], 200);
    expect(store.listActive().map((thread) => thread.id).sort()).toEqual(["a", "b"]);

    store.commitFull([item("b", 40)], 300);
    expect(store.listActive().map((thread) => thread.id)).toEqual(["b"]);
    state.close();
  });

  test("hot merge never deletes cold threads and preserves creation provenance", () => {
    const state = new StateDb(":memory:");
    const store = new CodexCatalogStore(state, "/home/codex");
    store.commitFull([item("a", 10), item("b", 20)], 100);
    store.mergeHot([{ ...item("a", 50), creationClient: { kind: "desktop", evidence: "originator" } }], 150);
    expect(store.listActive().map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(store.getThread("a")?.creationClient).toEqual({ kind: "desktop", evidence: "originator" });
    state.close();
  });

  test("fails closed when the catalog belongs to another CODEX_HOME", () => {
    const state = new StateDb(":memory:");
    new CodexCatalogStore(state, "/home/a").commitFull([item("a", 10)], 100);
    const other = new CodexCatalogStore(state, "/home/b");
    expect(other.listActive()).toEqual([]);
    expect(other.health().state).toBe("reinitialize_required");
    expect(() => other.commitFull([item("b", 20)], 200)).toThrow("codex_catalog_home_mismatch");
    state.close();
  });
});
