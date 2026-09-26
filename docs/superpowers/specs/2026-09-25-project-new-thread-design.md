# Design Spec: 项目下新建会话与模型切换 (Project New Thread & Model Switch)

- **Date**: 2026-09-25
- **Project**: sea-bridge
- **Planned Branch**: `feature/project-new-thread`
- **Status**: **Implemented — automated verification passed; target-host final acceptance pending**
- **Last Review**: 2026-09-25

---

## 0. 审核结论与修订原因

本次审核发现原方案存在会影响可用性的协议与架构问题。相关问题已纳入设计，并于 2026-09-25 在当前 Mac 的 bundled `codex app-server` 上完成关键协议链路 PoC，因此可以按修订后的方案进入实现：

1. **app-server 握手缺少 `initialized` 通知**。当前协议要求每个连接先发送 `initialize`，收到成功响应后再发送 `initialized`，之后才能调用其它 RPC。
2. **项目列表不应优先直读 `state_5.sqlite` 私有表结构**。当前 app-server 已提供实验性的 `project/list` / `project/read`，返回项目 id、name、roots、position 等字段。直接依赖 SQLite 表结构会把 Sea-Bridge 绑定到 Codex Desktop 的内部存储实现。
3. **“`thread/start` 后退出 app-server，再用 `codex queue` 投首轮消息”不可靠**。当前 `codex queue` 对未加载 thread 只负责入队，不负责 resume；可能返回成功，但消息长期停留在 pending，实际没有执行。
4. **首轮消息必须在创建 thread 的同一 app-server 执行上下文中通过 `turn/start` 启动**，并至少确认 `turn/start` 已成功接受后，才能向 Telegram 宣告“已创建并开始执行”。
5. **外部 app-server 创建 thread 的能力已在当前 Mac 实机验证**。上游仍存在 Desktop UI 同步相关 issue，因此实现不依赖“侧边栏即时刷新”作为协议正确性的前提；最终交付阶段仍需保留 Desktop UI 可见性/可打开性的验收，防止目标版本回归。
6. 原方案的交互式 `/new` 流程缺少**“已选择项目、等待第一轮 prompt”**的持久化状态，用户点击项目按钮后回复 ForceReply 时，服务端无法可靠知道应在哪个项目创建 thread。
7. 原方案的项目 SQL 对多 root 项目会产生重复项目行；同时按名称匹配也没有处理同名项目歧义。
8. 原方案 `model/list` 失败后回退到硬编码模型列表会产生过期/不可用模型风险。失败时应明确告知模型列表暂不可用，并允许继续使用 Codex 默认模型，不伪造模型能力。

### 上游依据

- App-server 初始化协议与 API：
  - https://github.com/openai/codex/tree/main/codex-rs/app-server
- App-server v2 项目协议：
  - https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/project.rs
- App-server v2 thread 协议：
  - https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread.rs
- `codex queue` 对 unloaded thread 不自动 resume：
  - https://github.com/openai/codex/issues/44491
- 外部 app-server thread 与 Desktop 实时侧边栏同步问题：
  - https://github.com/openai/codex/issues/30895
  - https://github.com/openai/codex/issues/30916
  - https://github.com/openai/codex/issues/36363

---

## 1. 目标与边界

Sea-Bridge 当前已经能把 Telegram 文本继续投递到已有 Codex thread。本功能希望补齐“从 Telegram 发起一个新任务”的入口。

### 1.1 目标

1. Telegram 可查看 Codex 当前纳管项目。
2. Telegram 可查看当前 app-server 实际返回的模型，并设置 Sea-Bridge 的默认模型偏好。
3. Telegram 可在指定项目下创建新 thread，并立即启动第一轮 turn。
4. 新 thread 创建成功后，Sea-Bridge 将 Telegram 回执与 threadId 建立映射，使后续直接输入优先路由到该 thread。
5. 在目标 Codex Desktop 版本验证通过的前提下，新 thread 能被正在运行的 Desktop 正常发现、打开和继续。

### 1.2 非目标

1. Sea-Bridge 不负责自行创建/选择 Git worktree；运行环境继续遵循 Codex 自身规则。
2. Sea-Bridge 不通过写入 `state_5.sqlite` 来伪造项目、thread 或 Desktop UI 状态。
3. 不承诺绕过 Codex Desktop 当前上游 UI 同步限制；协议级创建与执行能力已经通过 PoC，Desktop 侧边栏即时刷新/打开行为作为最终交付验收与版本回归检查，不再作为 Task 1 开始实施的阻断条件。
4. 不在本次功能中替换现有 Desktop 已有 thread 的 `codex queue` 回复链路；新建 thread 链路与既有回复链路需要清晰区分。

---

## 2. Phase 0：目标环境 PoC 结果（已通过）

2026-09-25 已在当前运行环境的 Mac 主机上直接启动 `/Applications/ChatGPT.app/Contents/Resources/codex app-server`，完成关键协议链路实测。DevSpace 容器内无法代表宿主机 Desktop 环境，因此以下结果以宿主机 PoC 为准。

已确认：

1. `codex app-server` 可通过 stdio JSON-RPC 正常启动和通信；
2. 握手顺序必须为 `initialize` → 成功响应 → `initialized`，之后再发送业务 RPC；
3. `project/list` 可正常返回本机 Codex 纳管项目，实测共返回 32 个项目；正式实现只依赖项目抽象中的 id/name/roots/position 等语义，不绑定 PoC 脚本的二次转换字段；
4. `model/list` 可返回当前账号实时可用模型，实测包含 `gpt-5-codex`、`gpt-5.1-codex`、`gpt-5.2-codex`、`gpt-5.3-codex` 等，因此无需硬编码模型枚举；
5. `thread/start` 可使用 `projectId`、`cwd`、`model` 创建 thread 并返回 `threadId`；
6. `turn/start` 的 text input 在当前 bundled 版本上要求携带 `textElements: []`，缺失该字段会触发参数校验失败；
7. `thread/start` 后在同一 app-server 上调用 `turn/start` 可以成功启动首轮并产生 rollout JSONL；
8. 首轮建立后，Sea-Bridge 现有 `DesktopObserver` 观察链路可以继续基于 rollout/thread history 工作；
9. 后续消息可继续复用现有 `ProcessCodexQueueClient`，即 `codex queue --thread <threadId> --message <text>`，PoC 已验证能够继续该 thread 的后续轮次。

### PoC 结论

核心协议 Gate 已通过，功能代码已在 `feature/project-new-thread` 分支完成实现。Desktop 侧边栏即时刷新、打开会话、服务重启后的恢复行为继续保留在最终集成验收中，用于检测版本回归。

---

## 3. 总体架构

PoC 通过后的正式架构如下：

```
┌─────────────────────────────────────────────────────────────┐
│                      Telegram Client                        │
│        /projects   /model   /new <index> <prompt>           │
│        Inline callbacks + ForceReply                        │
└──────────────────────────────┬──────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                       TelegramService                       │
│  - 命令/回调解析                                             │
│  - pending new-thread prompt 状态                            │
│  - 默认模型偏好                                              │
└───────────────┬───────────────────────────────┬─────────────┘
                │                               │
                ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│       NewThreadStateStore     │   │   CodexAppServerClient   │
│ - pending project selection   │   │ - initialize/initialized │
│ - creation idempotency        │   │ - project/list           │
│ - owned thread metadata       │   │ - model/list             │
└───────────────────────────────┘   │ - thread/start           │
                                    │ - turn/start             │
                                    └────────────┬─────────────┘
                                                 │
                                                 ▼
                                    ┌──────────────────────────┐
                                    │ DesktopMessageStore      │
                                    │ Telegram ↔ thread mapping│
                                    └──────────────────────────┘
```

### 关键原则

- **项目、模型、thread 创建均以 app-server 协议为准**。
- **首轮 prompt 用 `turn/start`，不使用 `codex queue`**。
- **只有 `turn/start` 成功接受后才发送成功回执**。
- `codex queue` 继续作为后续投递路径；Phase 0 已实测确认 Sea-Bridge 新建 thread 在首轮 `thread/start + turn/start` 成功并产生 rollout 后，也可由现有 `ProcessCodexQueueClient` 启动后续 turn。

---

## 4. CodexAppServerClient

### 4.1 进程与握手

文件建议：`src/desktop/codex-app-server-client.ts`

每个 app-server 连接必须执行：

```text
spawn codex app-server --stdio
  -> initialize(id=1)
  <- initialize result
  -> initialized(notification)
  -> target RPCs
```

JSON-RPC 消息显式带 `"jsonrpc": "2.0"`。

禁止在收到 initialize result 后直接调用其它 RPC。

### 4.2 接口

```ts
export interface ProjectItem {
  index: number;        // Telegram 展示用，1-based
  id: string;
  name: string;
  roots: string[];
  primaryRoot: string;
  position: number;
}

export interface ModelOption {
  id: string;
  displayName: string;
  isDefault: boolean;
}

export interface StartedThread {
  threadId: string;
  turnId: string;
  projectId: string;
  cwd: string;
  model: string | null;
}

export interface CodexAppServerClient {
  listProjects(): Promise<ProjectItem[]>;
  listModels(): Promise<ModelOption[]>;
  startThreadAndTurn(params: {
    projectId: string;
    cwd: string;
    model?: string;
    prompt: string;
  }): Promise<StartedThread>;
}
```

### 4.3 `project/list`

调用：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "project/list",
  "params": {
    "sortKey": "position",
    "sortDirection": "asc"
  }
}
```

要求：

- 开启 `experimentalApi: true`；
- 正确处理分页 `nextCursor`；
- project 无 root 时不提供给 `/new`；
- `primaryRoot = roots[0]`，这是本次版本的明确约定；
- 同名项目允许存在，因此名称匹配只能在**唯一匹配**时成功；
- 数字序号匹配只基于当次按 position 排序后的项目快照；
- Inline callback 使用 projectId，不使用不稳定的数字序号。

### 4.4 `model/list`

- 只展示 app-server 实际返回且未隐藏的模型；
- 保留“使用 Codex 默认模型”选项；
- 不维护硬编码模型 fallback；
- RPC 失败时提示“模型列表暂不可用”，原有默认模型偏好不自动改写。

### 4.5 `thread/start + turn/start`

顺序：

1. `thread/start`：
   - `projectId`
   - `cwd = primaryRoot`
   - 用户设置了默认模型时传 `model`；未设置则省略。
2. 成功拿到 `thread.id` 后，**在同一 app-server 连接**调用：
   ```json
   {
     "jsonrpc": "2.0",
     "id": 3,
     "method": "turn/start",
     "params": {
       "threadId": "<thread-id>",
       "input": [
         {
           "type": "text",
           "text": "[Telegram init]\n<user prompt>",
           "textElements": []
         }
       ]
     }
   }
   ```
3. 解析 `turn.id`；
4. 只有第 2 步成功后，`startThreadAndTurn()` 才返回成功。

**禁止**采用“`thread/start` → 关闭 app-server → `codex queue`”作为首轮启动路径。

### 4.6 生命周期与超时

- initialize、`project/list`、`model/list`、`thread/start`、`turn/start` 使用独立的 bounded timeout；
- 不把所有 RPC 统一写死为 5 秒；模型目录与账号/配置检查可能比普通本地 RPC 慢；
- 推荐初始值：
  - initialize: 10s
  - project/list: 10s
  - model/list: 20s
  - thread/start: 15s
  - turn/start ack: 15s
- 成功结束普通查询时优先关闭 stdin 并给进程短暂 graceful-exit 窗口，再升级到 SIGTERM/SIGKILL；
- 首轮 `turn/start` 后的 app-server 生命周期按 Phase 0 真机结果实现；实现时必须保留对 turn 已成功启动/产生 rollout 的确认，禁止仅凭 RPC ack 立即强杀进程并假定执行一定继续。
- Codex thread 采用单写者（active writer）所有权。Sea-Bridge 创建并执行首轮期间，独立 app-server 是该 thread 的 writer；收到匹配的 `turn/completed` 后必须显式调用 `thread/unsubscribe` 释放订阅/所有权，再关闭 app-server 进程。否则 Codex Desktop 重新打开该 thread 时可能提示“已在另一个应用中打开 / already has an active writer”。活跃 turn 尚未结束时不应强行释放 writer，否则可能中断正在执行的任务。

---

## 5. Sea-Bridge 状态持久化

### 5.1 默认模型偏好

Sea-Bridge 当前只允许单个 `allowedUserId` / `allowedChatId`，因此本次配置按实例级偏好即可，不伪装成多用户模型。

建议表：

```sql
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
```

键：

- `default_model`

支持删除该键以恢复“Codex 默认模型”。

### 5.2 Pending New Thread Prompt

交互式 `/new` 必须持久化等待状态：

```sql
CREATE TABLE IF NOT EXISTS pending_new_thread_prompts (
  telegram_chat_id TEXT NOT NULL,
  prompt_message_id INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  cwd TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','consumed','expired')),
  PRIMARY KEY (telegram_chat_id, prompt_message_id)
);
```

用途：

1. 用户发送 `/new`；
2. 点击项目按钮；
3. Sea-Bridge 发送 ForceReply 提示；
4. 将这条 ForceReply 消息 id 与 projectId/cwd 存入表；
5. 用户回复时，先查该 pending 状态；
6. 原子地从 `pending -> consumed`；
7. 调用 `startThreadAndTurn`。

这样可避免服务重启后丢失项目选择，也可阻止同一 ForceReply 被重复消费。

TTL：15 分钟。

### 5.3 新 thread 映射

`turn/start` 成功后发送 Telegram 回执，再写入 `DesktopMessageStore.link()`：

- `threadId`
- `turnId`
- `eventKind = "reply_prompt"` 或新增明确的 `"thread_created"`
- fingerprint 必须稳定且唯一。

后续“无 reply 直接输入”继续遵循现有 `findLatestLink(chatId)` 语义：投递到当前 Telegram Chat 最近一次收到 Sea-Bridge 通知所对应的 thread。

---

## 6. Telegram 交互

### 6.1 `/projects`

展示 position 排序后的项目：

```text
📁 Codex 项目：
[1] sea-bridge
    /opt/app/aitools/sea-bridge

[2] aining
    /opt/app/aining

快捷创建：
/new 1 审查当前分支
```

若项目数量较多，必须分段发送，避免 Telegram 单条消息长度限制。

### 6.2 `/model`

菜单第一项固定为：

```text
使用 Codex 默认模型
```

其余模型来自 `model/list`。

- 选择具体模型：保存 `default_model`；
- 选择默认：删除 `default_model`；
- 当前选择用 `🔘` 标识；
- callback 成功后通过 `editMessageReplyMarkup` 更新按钮状态。

### 6.3 `/new <project-index> <prompt>`

推荐直接路径使用**数字序号**：

```text
/new 1 帮我审查当前分支
```

执行：

1. 重新读取项目列表；
2. 按序号解析项目；
3. 读取默认模型；
4. `startThreadAndTurn`；
5. 成功后发送：
   ```text
   🚀 已创建会话并开始执行
   项目: sea-bridge
   会话: <threadId>
   模型: <model 或 Codex 默认>

   💡 提示：首轮任务正在 Sea-Bridge 后台执行。如果此时在 Codex Desktop 打开该会话，可能会提示“在另一个应用中打开”。待收到任务结束通知后，再在 Desktop 点击「重试」继续该会话。
   ```
6. 写入 Telegram ↔ thread 映射。

项目名直输只允许在**唯一匹配**时使用；含空格或同名项目推荐使用数字序号或 Inline Keyboard。

### 6.4 `/new` 交互路径

1. 用户发送 `/new`；
2. 显示项目 Inline Keyboard，每页最多 8 个项目，并提供上一页/下一页按钮；
3. callback 携带 projectId；分页 callback 与项目选择 callback 使用不同前缀；
4. 服务端根据 projectId 重新读取项目详情，防止使用陈旧路径；
5. 发送 ForceReply：
   ```text
   💬 已选择项目 [sea-bridge]，请回复此消息输入第一轮需求。
   ```
6. 写入 `pending_new_thread_prompts`；
7. 用户回复后消费 pending 状态并创建 thread。

如果 pending 已过期，提示重新发送 `/new`。

---

## 7. 后续消息投递策略

这里必须区分两类 thread：

### A. 既有 Codex Desktop thread

继续使用当前经过验证的：

```text
codex queue --thread <threadId> --message <text>
```

### B. Sea-Bridge 新建 thread

Phase 0 实机 PoC 已验证：首轮通过 app-server 的 `thread/start + turn/start` 建立并产生 rollout 后，后续输入可以复用现有 `ProcessCodexQueueClient`：

```text
codex queue --thread <threadId> --message <text>
```

因此本期不引入长期驻留的 app-server thread owner，也不新增第二套后续消息 dispatcher。现有 `DesktopMessageStore.findLatestLink(chatId)` 路由语义保持不变；`DesktopObserver` 继续负责观察新 turn 的状态和结果。

---

## 8. 异常与幂等

1. Telegram `update_id` 继续作为更新处理幂等基础。
2. pending prompt 使用数据库状态机保证只消费一次。
3. `thread/start` 成功、`turn/start` 失败：
   - 不发送“创建成功”；
   - 不把该 thread 设置为当前最新映射；
   - 记录 threadId 供诊断；
   - 清理 app-server 子进程；
   - 返回“新会话启动失败，请重试”。
4. `turn/start` 已返回成功但 Telegram 回执发送失败：
   - thread 已经开始执行；
   - 日志必须记录 threadId；
   - 不能自动重复创建 thread。
5. model preference 已过期：
   - 若 `thread/start` 明确返回 unknown/unsupported model，提示用户重新执行 `/model`；
   - 不偷偷切到另一个硬编码模型。
6. app-server 输出 malformed JSON、JSON-RPC error 或意外退出时，不能静默吞掉；日志应保留方法名、request id 与经过截断/脱敏的错误。
7. 多 root 项目仅使用 `roots[0]` 作为本期 primaryRoot；后续如需选择 root，再单独扩展交互。

---

## 9. 测试与验收

### 9.1 单元测试

- app-server：
  - initialize → initialized 顺序；
  - request id 关联；
  - notification 与 response 混流解析；
  - project/list pagination；
  - model/list；
  - thread/start；
  - turn/start；
  - timeout；
  - malformed JSON / RPC error / child exit；
  - graceful shutdown → forced kill fallback。
- Telegram：
  - `/projects`；
  - `/model` 选择与恢复默认；
  - `/new 1 <prompt>`；
  - `/new` → project callback → ForceReply → prompt；
  - pending prompt TTL；
  - 重复回复只消费一次；
  - 创建成功后 latest-link 路由到新 thread。
- StateDb migration：
  - settings；
  - pending_new_thread_prompts；
  - migration 重复执行安全。

### 9.2 集成验收

必须在目标 macOS 主机执行：

1. `bun test` 全部通过；
2. `/projects` 与 Desktop 项目一致；
3. `/model` 来自实时 model/list；
4. `/new 1 测试创建会话`：
   - thread/start 成功；
   - turn/start 成功；
   - 第一轮任务真实执行；
   - Desktop 不重启即可发现并打开；
   - Sea-Bridge observer 能收到后续状态；
5. 第一轮完成后直接在 Telegram 再发一条消息：
   - 路由到刚创建的 thread；
   - 必须真实开始下一 turn，不能只停留在 queue pending。

第 4、5 项属于目标 Mac 上的最终交付验收；协议级 PoC、代码实现和自动化回归已经完成。第二轮代码 Review 后的自动化验证结果：`bun test` 52/52 通过，`bun run typecheck`、`bun run build`、`git diff --check` 均通过。第二轮 Review 修复了新建 thread 首轮 Observer 基线竞态、活跃 app-server turn 的固定 30 分钟误杀风险、app-server 暂时不可用时 Telegram callback/update 堵塞，以及 pending ForceReply 过期/重复回复提示错误。
