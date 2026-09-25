# Project New Thread & Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable Telegram users to list projects, switch default AI models, and create new Codex Desktop threads under specific projects with automatic first-turn prompt delivery.

**Architecture:** Use `CodexProjectStore` to query local projects directly from `state_5.sqlite`, `CodexAppServerClient` to interact with Codex Desktop's underlying `codex app-server --stdio` JSON-RPC protocol for model discovery and `thread/start`, and integrate these into `TelegramService` to handle `/projects`, `/model`, and `/new` commands while reusing existing `ProcessCodexQueueClient` and `DesktopMessageStore`.

**Tech Stack:** TypeScript, Bun, SQLite (bun:sqlite), Node child_process, Telegram Bot API.

**Spec:** `docs/superpowers/specs/2026-09-25-project-new-thread-design.md`

## Global Constraints

- Never commit secrets, API keys, or personal tokens.
- Maintain existing TDD workflow; write failing tests before implementation.
- All commands and timeouts must have explicit bounds (app-server JSON-RPC timeout: 5000ms).
- Zero hallucination of CLI commands: use tested `codex app-server --stdio` JSON-RPC methods (`initialize`, `model/list`, `thread/start`).

---

### Task 1: CodexProjectStore (Query projects & roots)

**Files:**
- Create: `src/desktop/codex-project-store.ts`
- Test: `tests/codex-project-store.test.ts`

**Interfaces:**
- Consumes: `Database` from `bun:sqlite`
- Produces:
  ```ts
  export interface ProjectItem {
    index: number;
    id: string;
    name: string;
    rootPath: string;
    position: number;
  }
  export class CodexProjectStore {
    constructor(db: Database, existsSyncFn?: (path: string) => boolean);
    listProjects(): ProjectItem[];
    findProject(query: string): ProjectItem | null;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CodexProjectStore } from "../src/desktop/codex-project-store.ts";

describe("CodexProjectStore", () => {
  function createTestDb(): Database {
    const db = new Database(":memory:");
    db.run(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        position INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE project_roots (
        project_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        path TEXT NOT NULL,
        PRIMARY KEY (project_id, position)
      );
    `);
    db.run("INSERT INTO projects (id, name, position, created_at_ms, updated_at_ms) VALUES ('p1', 'sea-bridge', 0, 100, 100)");
    db.run("INSERT INTO project_roots (project_id, position, path) VALUES ('p1', 0, '/path/to/sea-bridge')");
    db.run("INSERT INTO projects (id, name, position, created_at_ms, updated_at_ms) VALUES ('p2', 'toolhub', 1, 100, 100)");
    db.run("INSERT INTO project_roots (project_id, position, path) VALUES ('p2', 0, '/path/to/toolhub')");
    return db;
  }

  test("lists projects with 1-based index and verified paths", () => {
    const db = createTestDb();
    const store = new CodexProjectStore(db, () => true);
    const list = store.listProjects();
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual({ index: 1, id: "p1", name: "sea-bridge", rootPath: "/path/to/sea-bridge", position: 0 });
    expect(list[1]).toEqual({ index: 2, id: "p2", name: "toolhub", rootPath: "/path/to/toolhub", position: 1 });
  });

  test("filters out projects whose paths do not exist", () => {
    const db = createTestDb();
    const store = new CodexProjectStore(db, (p) => p.includes("sea-bridge"));
    const list = store.listProjects();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("sea-bridge");
  });

  test("findProject matches by index number, exact name, or case-insensitive name", () => {
    const db = createTestDb();
    const store = new CodexProjectStore(db, () => true);
    expect(store.findProject("1")?.name).toBe("sea-bridge");
    expect(store.findProject("toolhub")?.id).toBe("p2");
    expect(store.findProject("TOOLHUB")?.id).toBe("p2");
    expect(store.findProject("non-existent")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/codex-project-store.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/desktop/codex-project-store.ts`:
```ts
import { existsSync } from "node:fs";
import type { Database } from "bun:sqlite";

export interface ProjectItem {
  index: number;
  id: string;
  name: string;
  rootPath: string;
  position: number;
}

export class CodexProjectStore {
  constructor(
    private readonly db: Database,
    private readonly pathExists: (path: string) => boolean = existsSync,
  ) {}

  listProjects(): ProjectItem[] {
    const rows = this.db.query(`
      SELECT p.id, p.name, p.position, pr.path AS rootPath
      FROM projects p
      LEFT JOIN project_roots pr ON p.id = pr.project_id
      ORDER BY p.position ASC
    `).all() as Array<{ id: string; name: string; position: number; rootPath: string | null }>;

    const valid: ProjectItem[] = [];
    let index = 1;
    for (const row of rows) {
      if (!row.rootPath || !this.pathExists(row.rootPath)) continue;
      valid.push({
        index: index++,
        id: row.id,
        name: row.name,
        rootPath: row.rootPath,
        position: row.position,
      });
    }
    return valid;
  }

  findProject(query: string): ProjectItem | null {
    const list = this.listProjects();
    const trimmed = query.trim();
    const num = parseInt(trimmed, 10);
    if (!Number.isNaN(num) && String(num) === trimmed) {
      return list.find((p) => p.index === num) ?? null;
    }
    const lower = trimmed.toLowerCase();
    return list.find((p) => p.name.toLowerCase() === lower) ?? null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/codex-project-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/desktop/codex-project-store.ts tests/codex-project-store.test.ts
git commit -m "feat(desktop): add CodexProjectStore for state_5 projects discovery"
```

---

### Task 2: CodexAppServerClient (JSON-RPC stdio client)

**Files:**
- Create: `src/desktop/codex-app-server-client.ts`
- Test: `tests/codex-app-server-client.test.ts`

**Interfaces:**
- Consumes: Node `child_process.spawn`
- Produces:
  ```ts
  export interface ModelOption {
    id: string;
    displayName: string;
    isDefault: boolean;
  }
  export class CodexAppServerClient {
    constructor(codexCliPath: string, timeoutMs?: number);
    listModels(): Promise<ModelOption[]>;
    startThread(params: { projectId: string; cwd: string; model?: string }): Promise<{ threadId: string }>;
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { CodexAppServerClient } from "../src/desktop/codex-app-server-client.ts";

class MockProcess extends EventEmitter {
  stdin = {
    write: (data: string) => {
      this.handleInput(data);
    },
    end: () => {},
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;

  kill(signal?: string) {
    this.killed = true;
    this.emit("close", 0, signal ?? null);
  }

  handleInput(data: string) {
    const lines = data.trim().split("\n");
    for (const line of lines) {
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.method === "initialize") {
        this.stdout.emit("data", JSON.stringify({ id: msg.id, jsonrpc: "2.0", result: { clientInfo: { name: "codex" } } }) + "\n");
      } else if (msg.method === "model/list") {
        this.stdout.emit("data", JSON.stringify({
          id: msg.id,
          jsonrpc: "2.0",
          result: {
            data: [
              { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true },
              { id: "o3", displayName: "o3", isDefault: false },
            ]
          }
        }) + "\n");
      } else if (msg.method === "thread/start") {
        this.stdout.emit("data", JSON.stringify({
          id: msg.id,
          jsonrpc: "2.0",
          result: {
            thread: { id: "01a0-mock-thread-id" }
          }
        }) + "\n");
      }
    }
  }
}

describe("CodexAppServerClient", () => {
  test("listModels performs initialize and returns model options", async () => {
    let mockProc: MockProcess | null = null;
    const runner = () => {
      mockProc = new MockProcess();
      return mockProc as any;
    };
    const client = new CodexAppServerClient("/dummy/path", 1000, runner);
    const models = await client.listModels();
    expect(models).toHaveLength(2);
    expect(models[0].id).toBe("gpt-5-codex");
    expect(models[0].isDefault).toBe(true);
    expect(mockProc?.killed).toBe(true);
  });

  test("startThread passes projectId, cwd and model and returns threadId", async () => {
    let mockProc: MockProcess | null = null;
    const runner = () => {
      mockProc = new MockProcess();
      return mockProc as any;
    };
    const client = new CodexAppServerClient("/dummy/path", 1000, runner);
    const result = await client.startThread({ projectId: "p1", cwd: "/tmp", model: "o3" });
    expect(result.threadId).toBe("01a0-mock-thread-id");
    expect(mockProc?.killed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/codex-app-server-client.test.ts`
Expected: FAIL with module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/desktop/codex-app-server-client.ts`:
```ts
import { spawn, type ChildProcess } from "node:child_process";

export interface ModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

type SpawnRunner = (command: string, args: string[]) => ChildProcess;

const DEFAULT_MODELS: ModelOption[] = [
  { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true },
  { id: "o3", displayName: "o3", isDefault: false },
  { id: "gpt-5", displayName: "GPT-5", isDefault: false },
];

export class CodexAppServerClient {
  constructor(
    private readonly codexCliPath: string,
    private readonly timeoutMs: number = 5000,
    private readonly spawner: SpawnRunner = spawn,
  ) {}

  async listModels(): Promise<ModelOption[]> {
    try {
      const response = await this.callRpc<{ data: Array<{ id: string; displayName?: string; isDefault?: boolean }> }>(
        "model/list",
        {},
      );
      if (!response?.data || !Array.isArray(response.data)) {
        return DEFAULT_MODELS;
      }
      return response.data.map((m) => ({
        id: m.id,
        displayName: m.displayName || m.id,
        isDefault: Boolean(m.isDefault),
      }));
    } catch {
      return DEFAULT_MODELS;
    }
  }

  async startThread(params: { projectId: string; cwd: string; model?: string }): Promise<{ threadId: string }> {
    const threadParams: Record<string, unknown> = {
      projectId: params.projectId,
      cwd: params.cwd,
    };
    if (params.model) {
      threadParams.model = params.model;
    }

    const response = await this.callRpc<{ thread: { id: string } }>("thread/start", threadParams);
    if (!response?.thread?.id) {
      throw new Error("app_server_thread_start_missing_id");
    }
    return { threadId: response.thread.id };
  }

  private callRpc<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return new Promise((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = this.spawner(this.codexCliPath, ["app-server", "--stdio"]);
      } catch (err) {
        return reject(err);
      }

      let resolved = false;
      let buffer = "";

      const cleanup = () => {
        clearTimeout(timer);
        if (!child.killed) {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      };

      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error("app_server_rpc_timeout"));
        }
      }, this.timeoutMs);

      child.stdout?.on("data", (chunk: Buffer | string) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id === 1) {
              // initialize finished, send target RPC
              const req = { method, id: 2, params };
              child.stdin?.write(JSON.stringify(req) + "\n");
            } else if (msg.id === 2) {
              if (!resolved) {
                resolved = true;
                cleanup();
                if (msg.error) {
                  reject(new Error(msg.error.message || "app_server_rpc_error"));
                } else {
                  resolve(msg.result as T);
                }
              }
            }
          } catch {}
        }
      });

      child.on("error", (err) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(err);
        }
      });

      child.on("close", (code) => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`app_server_closed_with_code_${code}`));
        }
      });

      // Send initialize request
      const initReq = {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: { name: "sea-bridge", version: "1.0.0" },
          capabilities: { experimentalApi: true },
        },
      };
      child.stdin?.write(JSON.stringify(initReq) + "\n");
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/codex-app-server-client.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/desktop/codex-app-server-client.ts tests/codex-app-server-client.test.ts
git commit -m "feat(desktop): add CodexAppServerClient for stdio JSON-RPC"
```

---

### Task 3: User Preference Store in StateDb

**Files:**
- Modify: `src/state/db.ts`
- Test: `tests/user-preference-store.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // In StateDb:
  getUserPreference(key: string): string | null;
  setUserPreference(key: string, value: string): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from "bun:test";
import { StateDb } from "../src/state/db.ts";

describe("StateDb - user preferences", () => {
  test("stores and retrieves user preferences", () => {
    const state = new StateDb(":memory:");
    expect(state.getUserPreference("default_model")).toBeNull();
    state.setUserPreference("default_model", "o3");
    expect(state.getUserPreference("default_model")).toBe("o3");
    state.setUserPreference("default_model", "gpt-5-codex");
    expect(state.getUserPreference("default_model")).toBe("gpt-5-codex");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/user-preference-store.test.ts`
Expected: FAIL with method not defined

- [ ] **Step 3: Modify StateDb implementation**

In `src/state/db.ts`:
Add table creation:
```sql
CREATE TABLE IF NOT EXISTS user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```
Add methods:
```ts
getUserPreference(key: string): string | null {
  const row = this.db.query("SELECT value FROM user_preferences WHERE key=?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

setUserPreference(key: string, value: string): void {
  this.db.query(`
    INSERT INTO user_preferences (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
  `).run(key, value, Date.now());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/user-preference-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/state/db.ts tests/user-preference-store.test.ts
git commit -m "feat(state): add user preferences table to StateDb"
```

---

### Task 4: Telegram commands: /projects and /model

**Files:**
- Modify: `src/telegram/service.ts`
- Test: `tests/telegram-model-projects.test.ts`

**Interfaces:**
- Consumes: `CodexProjectStore`, `CodexAppServerClient`, `StateDb`
- Produces: Handling for `/projects`, `/model`, and callback `model:<id>`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test, mock } from "bun:test";
import { TelegramService } from "../src/telegram/service.ts";
import { StateDb } from "../src/state/db.ts";

describe("TelegramService - /projects and /model", () => {
  test("handles /projects by listing available projects", async () => {
    const sent: any[] = [];
    const mockClient: any = {
      sendMessage: mock(async (chatId, text) => {
        sent.push({ chatId, text });
        return { message_id: 101, chat: { id: chatId } };
      }),
    };
    const mockProjectStore: any = {
      listProjects: () => [
        { index: 1, id: "p1", name: "sea-bridge", rootPath: "/opt/app/aitools/sea-bridge" },
      ],
    };
    const state = new StateDb(":memory:");
    const service = new TelegramService(
      { allowedUserId: "1", allowedChatId: "2" } as any,
      state,
      mockClient,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { info: () => {}, warn: () => {} } as any,
      undefined,
      mockProjectStore,
    );

    await (service as any).handleMessage({
      update_id: 1,
      message: { message_id: 1, chat: { id: 2 }, from: { id: 1 }, text: "/projects" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("[1] sea-bridge");
    expect(sent[0].text).toContain("/opt/app/aitools/sea-bridge");
  });

  test("handles /model by sending keyboard with current default marked", async () => {
    const sent: any[] = [];
    const mockClient: any = {
      sendMessage: mock(async (chatId, text, replyMarkup) => {
        sent.push({ chatId, text, replyMarkup });
        return { message_id: 102, chat: { id: chatId } };
      }),
    };
    const mockAppServerClient: any = {
      listModels: async () => [
        { id: "gpt-5-codex", displayName: "GPT-5 Codex", isDefault: true },
        { id: "o3", displayName: "o3", isDefault: false },
      ],
    };
    const state = new StateDb(":memory:");
    state.setUserPreference("default_model", "o3");

    const service = new TelegramService(
      { allowedUserId: "1", allowedChatId: "2" } as any,
      state,
      mockClient,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { info: () => {}, warn: () => {} } as any,
      undefined,
      undefined,
      mockAppServerClient,
    );

    await (service as any).handleMessage({
      update_id: 2,
      message: { message_id: 2, chat: { id: 2 }, from: { id: 1 }, text: "/model" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("当前选用: o3");
    const buttons = sent[0].replyMarkup.inline_keyboard.flat();
    expect(buttons.find((b: any) => b.text.includes("o3")).text).toContain("🔘");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/telegram-model-projects.test.ts`
Expected: FAIL with unsupported command or missing store

- [ ] **Step 3: Modify TelegramService to support /projects, /model, and model: callback**

Update `src/telegram/service.ts`:
- Inject `projectStore?: CodexProjectStore` and `appServerClient?: CodexAppServerClient` in constructor.
- Add handler methods:
  - `sendProjects(chatId: number)`
  - `sendModelMenu(chatId: number)`
  - `handleModelCallback(callback: TelegramCallbackQuery)`

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test tests/telegram-model-projects.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/telegram/service.ts tests/telegram-model-projects.test.ts
git commit -m "feat(telegram): add /projects and /model command handlers"
```

---

### Task 5: Telegram /new command & project selection flow

**Files:**
- Modify: `src/telegram/service.ts`
- Modify: `src/main.ts`
- Test: `tests/telegram-new-thread.test.ts`

**Interfaces:**
- Consumes: `CodexProjectStore`, `CodexAppServerClient`, `ProcessCodexQueueClient`, `DesktopMessageStore`
- Produces: Complete flow for `/new <project> <prompt>`, `/new` button picker, and callback `proj:<id>`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test, mock } from "bun:test";
import { TelegramService } from "../src/telegram/service.ts";
import { StateDb } from "../src/state/db.ts";

describe("TelegramService - /new thread creation", () => {
  test("direct creation /new 1 <prompt> starts thread and queues initial message", async () => {
    const sent: any[] = [];
    const mockClient: any = {
      sendMessage: mock(async (chatId, text, replyMarkup) => {
        sent.push({ chatId, text, replyMarkup });
        return { message_id: 201, chat: { id: chatId } };
      }),
    };
    const mockProjectStore: any = {
      listProjects: () => [{ index: 1, id: "p1", name: "sea-bridge", rootPath: "/opt/app/aitools/sea-bridge" }],
      findProject: (q: string) => q === "1" || q === "sea-bridge" ? { index: 1, id: "p1", name: "sea-bridge", rootPath: "/opt/app/aitools/sea-bridge" } : null,
    };
    const mockAppServerClient: any = {
      startThread: mock(async (params) => ({ threadId: "01a0-new-thread-123" })),
    };
    const mockQueueClient: any = {
      queue: mock(async (threadId, text) => ({ status: "delivered", exitCode: 0 })),
    };
    const mockMessageStore: any = {
      link: mock(() => {}),
    };

    const state = new StateDb(":memory:");
    state.setUserPreference("default_model", "gpt-5-codex");

    const service = new TelegramService(
      { allowedUserId: "1", allowedChatId: "2" } as any,
      state,
      mockClient,
      {} as any,
      {} as any,
      mockMessageStore,
      mockQueueClient,
      { info: () => {}, warn: () => {} } as any,
      undefined,
      mockProjectStore,
      mockAppServerClient,
    );

    await (service as any).handleMessage({
      update_id: 10,
      message: { message_id: 10, chat: { id: 2 }, from: { id: 1 }, text: "/new 1 帮我写单元测试" },
    });

    expect(mockAppServerClient.startThread).toHaveBeenCalledWith({
      projectId: "p1",
      cwd: "/opt/app/aitools/sea-bridge",
      model: "gpt-5-codex",
    });
    expect(mockQueueClient.queue).toHaveBeenCalledWith(
      "01a0-new-thread-123",
      "[Telegram init]\n帮我写单元测试"
    );
    expect(mockMessageStore.link).toHaveBeenCalled();
    expect(sent[0].text).toContain("已在项目 [sea-bridge] 下创建新会话");
  });

  test("empty /new prompts user with project buttons", async () => {
    const sent: any[] = [];
    const mockClient: any = {
      sendMessage: mock(async (chatId, text, replyMarkup) => {
        sent.push({ chatId, text, replyMarkup });
        return { message_id: 202, chat: { id: chatId } };
      }),
    };
    const mockProjectStore: any = {
      listProjects: () => [{ index: 1, id: "p1", name: "sea-bridge", rootPath: "/opt/app/aitools/sea-bridge" }],
      findProject: () => null,
    };
    const state = new StateDb(":memory:");
    const service = new TelegramService(
      { allowedUserId: "1", allowedChatId: "2" } as any,
      state,
      mockClient,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      { info: () => {}, warn: () => {} } as any,
      undefined,
      mockProjectStore,
    );

    await (service as any).handleMessage({
      update_id: 11,
      message: { message_id: 11, chat: { id: 2 }, from: { id: 1 }, text: "/new" },
    });

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("请选择要在哪个项目下新建会话");
    expect(sent[0].replyMarkup.inline_keyboard[0][0].text).toContain("sea-bridge");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/telegram-new-thread.test.ts`
Expected: FAIL with /new unsupported

- [ ] **Step 3: Implement /new handling & proj: callback, update main.ts wiring**

In `src/telegram/service.ts`:
- Add regex matching for `/new(?:\s+(\S+)(?:\s+([\s\S]+))?)?`
- Implement `handleNewCommand(chatId, projectQuery, prompt)`
- Implement `handleProjectCallback(callbackQuery)`
In `src/main.ts`:
- Instantiate `CodexProjectStore` using existing `codexStateDbPath`
- Instantiate `CodexAppServerClient` using existing `codexCliPath`
- Pass them into `TelegramService`

- [ ] **Step 4: Run all tests to verify full regression safety**

Run: `bun test`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
git add src/telegram/service.ts src/main.ts tests/telegram-new-thread.test.ts
git commit -m "feat(telegram): support /new project session creation and initial prompt delivery"
```

