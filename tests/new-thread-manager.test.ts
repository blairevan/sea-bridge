import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";
import { NewThreadStateStore } from "../src/state/new-thread-state-store.ts";
import { NewThreadManager } from "../src/desktop/new-thread-manager.ts";

describe("NewThreadManager", () => {
  test("filters missing project paths and reindexes visible projects", async () => {
    const state = new StateDb(":memory:");
    const store = new NewThreadStateStore(state);
    const manager = new NewThreadManager({
      listProjects: async () => [
        { index: 1, id: "missing", name: "missing", roots: ["/missing"], primaryRoot: "/missing", position: 0 },
        { index: 2, id: "p2", name: "two", roots: ["/two"], primaryRoot: "/two", position: 1 },
        { index: 3, id: "p3", name: "three", roots: ["/three"], primaryRoot: "/three", position: 2 },
      ],
      listModels: async () => [],
      startThreadAndTurn: async () => { throw new Error("not used"); },
    } as any, store, { pathExists: (path) => path !== "/missing" });

    const projects = await manager.listProjects();
    expect(projects.map((project) => [project.index, project.id])).toEqual([[1, "p2"], [2, "p3"]]);
    expect((await manager.findProject("1"))?.id).toBe("p2");

    state.close();
  });

  test("rejects a pending project whose path disappeared before the user replied", async () => {
    const state = new StateDb(":memory:");
    const store = new NewThreadStateStore(state);
    let starts = 0;
    const manager = new NewThreadManager({
      listProjects: async () => [],
      listModels: async () => [],
      startThreadAndTurn: async () => {
        starts += 1;
        throw new Error("should not be called");
      },
    } as any, store, { pathExists: () => false });

    await expect(manager.startPendingThread("456", {
      chatId: "456",
      promptMessageId: 1,
      projectId: "p1",
      projectName: "gone",
      cwd: "/gone",
      expiresAt: Date.now() + 1000,
    }, "build it")).rejects.toThrow("project_path_missing");
    expect(starts).toBe(0);

    state.close();
  });
});
