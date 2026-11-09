# Antigravity ACP Web MVP 实施计划（Sub-plan 1：P0 + P1 + P2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task after user approval of this plan and explicit implementation authorization. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** 在不改变现有 Codex 与 dsh 行为的前提下，完成 Antigravity ACP 协议与隔离边界实测（P0）、ACP 基础层与数据库迁移（P1），以及 Web 端托管会话闭环、新建前“模型 + 思考等级（Effort）”分离选择、Web 在线权限审批、精确停止与 `Antigravity` 桌面端会话只读展示（P2）。
- **Architecture:** SeaBridge 作为官方 `agy acp` 的 stdio JSON-RPC 客户端管理自有托管会话；通过只读执行 `agy models` 并按模型家族聚合生成“基础模型 + 思考等级”二级目录；通过 `mode=ro` 只读查询 `~/.gemini/antigravity/conversation_summaries.db` 与 `brain/<id>/.system_generated/logs/transcript.jsonl` 展示 `Antigravity` 桌面端顶层会话列表与历史（`sendEnabled: false`，不调用有副作用的 `session/load`）。
- **Tech Stack:** Bun, TypeScript, `bun:sqlite`, 原生 Web DOM/CSS/SSE, Node/Bun `child_process` stdio JSON-RPC (NDJSON)。不新增任何第三方运行时依赖。
- **Reference Spec:** [docs/superpowers/specs/2026-11-07-antigravity-acp-integration-design.md](../specs/2026-11-07-antigravity-acp-integration-design.md)
- **Subsequent Sub-plans:**
  - Sub-plan 2（P3）：Telegram 全能力接入（`/agy_status`、`/agy_projects`、`/agy_model`、`/agy_new`、三方回复路由、桌面会话通知观察器与 Web/TG 共享审批）
  - Sub-plan 3（P4）：`Antigravity` 桌面端与 `agy` CLI 跨进程 SQLite WAL 原会话写入互通验证
  - Sub-plan 4（P5）：ToolHub 受监督任务执行评估

---

## 1. 全局约束与红线（Global Constraints）

1. **单文件 ≤ 400 行红线**：所有新增模块必须职责单一、单文件不超过 400 行。`src/main.ts`（现 372 行）必须通过 `src/antigravity/bootstrap.ts` 薄委托装配；P3 接入 Telegram 时同样通过独立 `telegram-handler.ts` 委托，不在 `src/telegram/service.ts`（现 1,152 行）堆砌分支。
2. **零新增依赖**：不安装任何新的 npm/bun 包（包括不静默引入外部 ACP SDK）。
3. **模型（Model）与思考等级（Effort / `reasoningEffort`）严格分离**：
   - `model-catalog.ts` 将 `agy models` 的 13 条变体按模型家族聚合为 5 个基础模型 `CatalogItem`（`{ id, name, defaultReasoningEffort, supportedReasoningEfforts }`）；
   - 多档位模型（`Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`、`Claude Sonnet 5.5`）提供 `low / medium / high` 独立思考等级选择，默认等级取 `agy models` 中该家族首行；
   - 单档位模型（`GPT-OSS 120B (Medium)`）不返回可切换的多档 `supportedReasoningEfforts`，前端自动禁用思考等级下拉框；
   - 新建（`POST /api/sessions`）、空闲态修改模型（`POST /api/sessions/antigravity/:id/model`）和会话元数据（`WebSessionMeta`）均将 `modelId` 与 `reasoningEffort` 分离传递和展示。
4. **`Antigravity` 桌面端只读安全边界**：
   - `desktop-reader.ts` 仅以 `file:~/.gemini/antigravity/conversation_summaries.db?mode=ro` 只读打开桌面摘要库，过滤 `nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0`；
   - 仅只读读取校验过 UUID 与 `realpath` 的 `~/.gemini/antigravity/brain/<id>/.system_generated/logs/transcript.jsonl`（存在 `truncated_fields` 时回退同目录 `transcript_full.jsonl`）；
   - P0–P2 绝不对桌面端外部会话调用 `session/load`，外部桌面会话在 Web 端固定 `sendEnabled: false`。
5. **`Antigravity IDE` 与全局进程保护**：
   - 不针对 `Antigravity IDE.app` 做适配；
   - 固定使用经校验的 `SEA_BRIDGE_ANTIGRAVITY_CLI_PATH`（默认 `/Users/zhuhaijun/.local/bin/agy` `1.5.2`），不混用 `~/.gemini/bin/agy`；
   - 清理或取消 worker 时只按子进程 PID + 启动时间 + `processGeneration` 终止本服务创建的 `agy acp` 进程，严禁按进程名宽泛匹配误杀 `Antigravity.app` 的 `language_server`、`Antigravity IDE` 的 `agy --hub` 或 CLI 的 `agy --bg-updater`。
6. **幂等与防重发**：
   - 创建或发送一旦跨过进程写入边界后断连，状态标为 `delivery_unknown` / `unknown`，绝不自动重试、不退回 `--continue`、不隐式新建第二个会话。

---

## 2. 文件映射表（File Map）

| 文件路径 | 职责说明 |
| --- | --- |
| `docs/ai/2026-11-09-antigravity-acp-poc.md` | Task 0（P0）真实隔离环境协议探测、`(modelId, reasoningEffort)` -> `configOptions` 映射、权限与取消实测报告（脱敏）。 |
| `tests/fixtures/antigravity-acp/*.json` | Task 0 采集的脱敏 ACP 初始化、`session/new`、`configOptions`、`session/update`、`request_permission` 与 `agy models` 输出样本。 |
| `src/state/db.ts` | 新增 `migrateAntigravityBridgeTables(db)`，随 `StateDb` 初始化创建 `antigravity_*` 核心表与索引。 |
| `src/web/migrations.ts` | 新增 `version = 3` 原子迁移，将 `web_operations.source` 的 CHECK 约束扩展为 `('codex','dsh','antigravity')`。 |
| `src/web/store.ts` | 扩展来源联合类型；新增 `transitionQueuedOperation`（允许 `queued -> accepted \| failed \| delivery_unknown`）；允许在 `dispatching \| queued` 阶段更新 `session_id` / `turn_id`。 |
| `src/antigravity/config.ts` | 解析并校验 `SEA_BRIDGE_ANTIGRAVITY_*` 环境变量、可执行文件路径及允许项目目录配置。 |
| `src/antigravity/protocol.ts` | ACP v1 JSON-RPC 请求、响应、通知（`session/update`）与反向请求（`session/request_permission`）运行时类型校验器。 |
| `src/antigravity/capabilities.ts` | 维护握手能力门控、版本/摘要校验与对外状态投影（`limited / stale / unavailable / protocol_incompatible`）。 |
| `src/antigravity/transport.ts` | 受控 `agy acp` 子进程启动（argv 方式）、NDJSON 分帧、UTF-8 拼包、超长帧保护、stdin 背压与进程身份/代次管理。 |
| `src/antigravity/client.ts` | 基于 `transport` 的类型化 ACP 方法调用（`initialize`、`session/new`、`session/load`、`session/resume`、`session/set_config_option`、`session/prompt`、`session/cancel`、`session/close`）。 |
| `src/antigravity/model-catalog.ts` | 只读执行 `agy models`，剥离转轮控制序列，按家族聚合基础模型与思考等级（`defaultReasoningEffort`、`supportedReasoningEfforts`），维护 `(baseModelId, reasoningEffort) <-> rawVariantId` 双向索引与缓存。 |
| `src/antigravity/desktop-reader.ts` | 只读（`mode=ro`）读取 `~/.gemini/antigravity/conversation_summaries.db` 顶层会话与 `brain/<id>/.system_generated/logs/transcript.jsonl` 历史。 |
| `src/antigravity/store.ts` | 封装 `antigravity_projects`、`antigravity_sessions`、`antigravity_executions`、`antigravity_messages`、`antigravity_approvals` 的 CRUD 与状态机事务。 |
| `src/antigravity/projection.ts` | 将托管会话 `session/update` 事件流与桌面端 `transcript.jsonl` 统一投影为 `WebMessage`、工具摘要与 `WebSessionMeta`（分离展示 `model` 与 `reasoningEffort`）。 |
| `src/antigravity/approval-bridge.ts` | 管理 `session/request_permission` pending 生命周期、一次性决策（`optionId`）、5 分钟超时自动取消及跨通道状态同步。 |
| `src/antigravity/policy.ts` | 校验允许项目 `realpath`、符号链接边界、会话 ID 格式与进程安全参数。 |
| `src/antigravity/session-manager.ts` | 单会话串行 actor：同步完成 `session/new` + 模型/思考等级配置、异步执行 `session/prompt`、`queued -> accepted` 推进、`session_busy` 互斥、绑定 `expectedExecutionId + expectedEpoch` 的精确停止与 worker 回收。 |
| `src/antigravity/bootstrap.ts` | 封装 Antigravity 模块初始化与优雅停机钩子，供 `src/main.ts` 薄调用。 |
| `src/web/sources/antigravity.ts` | 实现 `WebSource` 接口，按 `sessionId`（`nativeSessionId`）合并去重托管会话（`sea_bridge`）与桌面只读会话（`desktop`）。 |
| `src/web/sources/types.ts`、`src/web/types.ts` | 扩展三来源类型、`executionControl`、`approvalTransport`、`updateModel(sessionId, modelId, reasoningEffort?)` 与 `interruptExecution`。 |
| `src/web/{http,operations,status,runtime,session-list,records}.ts` | 放行 `antigravity` 来源、接入 `creationClient` 过滤与操作诊断记录、扩展 `/model` 与 `/interrupt` 路由、新增 Web 审批路由 `POST /api/sessions/antigravity/:id/approvals/:approvalId`。 |
| `src/web/public/{index.html,app.css,app.js}` | 新增 Antigravity 来源切换、复用模型 + 思考等级双下拉框、展示桌面只读标识、渲染 Web 在线审批卡片与精确停止按钮。 |
| `tests/antigravity-{migrations,transport,model-catalog,desktop-reader,session-manager,approval,history}.test.ts`、`tests/web-antigravity-source.test.ts` | 针对各模块的独立单元与故障注入测试。 |

---

## 3. 分步实施任务（Tasks）

### Task 0（P0）：验证本机 `agy acp` 真实协议契约与隔离目录边界

**Files:**
- Create: `docs/ai/2026-11-09-antigravity-acp-poc.md`
- Create: `tests/fixtures/antigravity-acp/README.md` 及脱敏 JSON/文本样本

- [x] **Step 1：验证隔离目录参数与认证状态**
  - 在不触碰 `~/.gemini/antigravity`（桌面端正在使用的目录）的前提下，验证 `agy acp --gemini-dir=/Users/zhuhaijun/.gemini --app-data-dir=<isolated_or_cli_dir>` 的目录写入范围与认证可用性。
  - 确认命令不会在 `~/.gemini/antigravity/conversations/` 或 `conversation_summaries.db` 中产生任何写入。
- [x] **Step 2：实测 `session/new` 的 `configOptions` 与“模型 + 思考等级”映射关系**
  - 在获得实施授权后的隔离测试会话中调用一次 `session/new`，记录返回的 `configOptions` 完整脱敏结构。
  - 验证前端选择的 `(baseModelId, reasoningEffort)`（如 `("gemini-4-argon", "high")`）在 `session/set_config_option` 中是传给单一 `model` 选项（`gemini-4-argon-high`）还是分传 `model` + `thought_level`，并验证切换响应。
- [x] **Step 3：实测两轮 `session/prompt`、权限请求（`request_permission`）、`session/cancel` 与 `load/resume`**
  - 验证同一 `nativeSessionId` 连续两轮对话、`stopReason` 返回值、工具权限请求的 `options` 结构（记录真实 `optionId`）、取消后旧 worker 结算行为以及 `session/load` 回放事件特征。
- [x] **Step 4：固化脱敏 Fixture 与 P0 报告**
  - 将脱敏后的协议帧写入 `tests/fixtures/antigravity-acp/`，在 `docs/ai/2026-11-09-antigravity-acp-poc.md` 记录 Go/No-Go 结论，运行 `git diff --check`。

---

### Task 1（P1-A）：数据库迁移与 `WebStore` 二阶段状态推进扩展

**Files:**
- Modify: `src/state/db.ts`
- Modify: `src/web/migrations.ts`
- Modify: `src/web/store.ts`
- Create: `src/antigravity/store.ts`
- Create: `tests/antigravity-migrations.test.ts`

- [x] **Step 1：先写迁移与状态机失败/边界测试（TDD）**
  - 在 `tests/antigravity-migrations.test.ts` 中编写测试：
    1. 旧版 `version = 2` Web 数据库包含存量 `codex` / `dsh` 的 `web_operations` 和 `web_message_snapshots` 记录，升级到 `version = 3` 后数据、索引、`ON DELETE CASCADE` 外键全部保留，`PRAGMA foreign_key_check` 与 `PRAGMA integrity_check` 通过；
    2. 写入 `source = 'antigravity'` 的操作记录成功，非法来源仍被 CHECK 拒绝；
    3. `beforeCommit` 抛错时事务完整回滚；
    4. `WebStore.transitionQueuedOperation` 仅允许 `queued -> accepted | failed | delivery_unknown`，且转为 `accepted` 后 `listAcceptedMessageSnapshots("antigravity", sessionId)` 能正确读出用户消息快照；
    5. `StateDb` 独立初始化（不调 `migrateWeb`）时，`antigravity_*` 表均已就绪。
- [x] **Step 2：实现 `migrateAntigravityBridgeTables`、`migrateWeb` v3 与 `AntigravityStore`**
  - 在 `src/state/db.ts` 中新增 `migrateAntigravityBridgeTables(db)`；
  - 在 `src/web/migrations.ts` 中实现 `version = 3` 表重建与数据迁移；
  - 在 `src/web/store.ts` 中扩展来源类型并新增 `transitionQueuedOperation`；
  - 在 `src/antigravity/store.ts` 中实现托管会话、执行、消息快照和审批记录的持久化方法。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-migrations.test.ts tests/web-store.test.ts && bun run typecheck`。

---

### Task 2（P1-B）：ACP NDJSON 传输层、运行时协议校验与 Client

**Files:**
- Create: `src/antigravity/protocol.ts`
- Create: `src/antigravity/capabilities.ts`
- Create: `src/antigravity/transport.ts`
- Create: `src/antigravity/client.ts`
- Create: `tests/antigravity-transport.test.ts`

- [x] **Step 1：编写传输与协议边界测试（TDD）**
  - 在 `tests/antigravity-transport.test.ts` 中覆盖：分片 UTF-8 多字节字符跨 chunk 拼接、超长单行拒绝、非 JSON 噪声行隔离、双向 JSON-RPC（客户端请求 + 服务端 `session/request_permission` 反向请求 + `session/update` 通知）、请求超时、进程异常退出、以及 `protocolVersion !== 1` 时标记 `protocol_incompatible`。
- [x] **Step 2：实现 `protocol.ts`、`capabilities.ts`、`transport.ts`、`client.ts`**
  - 使用 `spawn(cliPath, args, { stdio: ["pipe", "pipe", "pipe"] })` 启动，严禁 `shell: true`；
  - 记录子进程 `pid`、`startedAt` 与 `processGeneration`，关闭时只清理当前实例持有的子进程；
  - 兼容 Task 0 实测确认的 camelCase / snake_case 字段。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-transport.test.ts && bun run typecheck`。

---

### Task 3（P1-C）：`agy models` 模型与思考等级（Effort）分离聚合目录

**Files:**
- Create: `src/antigravity/model-catalog.ts`
- Create: `tests/antigravity-model-catalog.test.ts`

- [x] **Step 1：编写模型与思考等级分离聚合测试（TDD）**
  - 在 `tests/antigravity-model-catalog.test.ts` 中使用真实 `agy models` 原始输出（含 `\r⠋ Fetching available models...` 控制符前缀与 13 条变体）测试：
    1. 输出被精确聚合为 5 个 `CatalogItem`：
       - `gemini-4-argon`（`name: "Gemini 4 Argon"`，`defaultReasoningEffort: "medium"`，`supportedReasoningEfforts: ["low", "medium", "high"]`）
       - `gemini-3.8-flash`（`name: "Gemini 3.8 Flash"`，`defaultReasoningEffort: "high"`，`supportedReasoningEfforts: ["low", "medium", "high"]`）
       - `claude-opus-5-5`（`name: "Claude Opus 5.5"`，`defaultReasoningEffort: "low"`，`supportedReasoningEfforts: ["low", "medium", "high"]`）
       - `claude-sonnet-5-5`（`name: "Claude Sonnet 5.5"`，`defaultReasoningEffort: "low"`，`supportedReasoningEfforts: ["low", "medium", "high"]`）
       - `gpt-oss-120b-medium`（`name: "GPT-OSS 120B (Medium)"`，无多档可调 `supportedReasoningEfforts`）
    2. 双向解析：`resolveVariantId("gemini-4-argon", "high") === "gemini-4-argon-high"`，反向 `splitVariantId("gemini-4-argon-high")` 返回 `{ model: { id: "gemini-4-argon", displayName: "Gemini 4 Argon" }, reasoningEffort: "high" }`；
    3. 缓存命中与失效、`agy models` 超时/非零退出时的安全降级。
- [x] **Step 2：实现 `model-catalog.ts`**
  - 使用固定绝对路径与超时限制执行 `agy models`，实现 ANSI / `\r` 剥离、家族聚合与双向映射。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-model-catalog.test.ts && bun run typecheck`。

---

### Task 4（P1-D）：`Antigravity` 桌面端只读会话列表与 `transcript.jsonl` 历史读取器

**Files:**
- Create: `src/antigravity/policy.ts`
- Create: `src/antigravity/desktop-reader.ts`
- Create: `tests/antigravity-desktop-reader.test.ts`

- [x] **Step 1：编写桌面只读读取测试（TDD）**
  - 在 `tests/antigravity-desktop-reader.test.ts` 中构造临时 SQLite `conversation_summaries.db` 与 `brain/<id>/.system_generated/logs/{transcript.jsonl,transcript_full.jsonl}` 测试：
    1. 仅返回 `nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0` 的顶层会话，过滤掉子代理（`nesting_depth > 0`）和已终止会话；
    2. `CASCADE_RUN_STATUS_RUNNING` 或 `not_fully_idle = 1` 映射为 `running`，`CASCADE_RUN_STATUS_IDLE` 映射为 `idle`；
    3. `workspace_uris` 中的 `file://` 路径与允许项目根匹配时正确关联 `projectId`；
    4. 解析 `transcript.jsonl` 中的 `USER_INPUT` 与 `PLANNER_RESPONSE`（含 `tool_calls` 摘要），当某行带 `truncated_fields` 时自动按对应行/步骤从 `transcript_full.jsonl` 补全正文；
    5. 拒绝非法 `conversation_id`（如 `../` 路径穿越或符号链接越界）。
- [x] **Step 2：实现 `policy.ts` 与 `desktop-reader.ts`**
  - 使用 `new Database(\`file:\${dbPath}?mode=ro\`, { readonly: true })` 打开摘要库；
  - 严格校验 `brain/<id>` 的 UUID 格式与 `realpathSync` 前缀。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-desktop-reader.test.ts && bun run typecheck`。

---

### Task 5（P1-E）：托管会话管理器、权限审批桥接与历史投影

**Files:**
- Create: `src/antigravity/projection.ts`
- Create: `src/antigravity/approval-bridge.ts`
- Create: `src/antigravity/session-manager.ts`
- Create: `tests/antigravity-session-manager.test.ts`
- Create: `tests/antigravity-approval.test.ts`
- Create: `tests/antigravity-history.test.ts`

- [x] **Step 1：编写会话管理、审批竞态与历史回放测试（TDD）**
  - 覆盖以下核心场景：
    1. `create()` 同步完成 `session/new` + 模型/思考等级设置并调用 `onSessionKnown(nativeSessionId)`，随后异步发送 `session/prompt`；
    2. 收到首个有效 `session/update` 或 `session/prompt` 响应时，调用 `transitionQueuedOperation` 将操作从 `queued` 推进为 `accepted`；若未收到任何执行证据即断连，推进为 `delivery_unknown` 且绝不自动重发；
    3. 同一会话在途执行未完成时再次调用 `send()`，立即返回 `session_busy`；
    4. 停止执行（`interruptExecution`）严格校验 `expectedExecutionId + expectedEpoch`：不匹配返回 `active_execution_changed`，已结束返回 `interrupt_already_finished`；发送 `session/cancel` 后结清未决权限请求，并在该轮结算后淘汰当前 worker 进程，下一轮以新 generation 恢复同一 `nativeSessionId`；
    5. 权限请求（`request_permission`）仅允许决策一次（返回真实 `optionId`），超时（默认 5 分钟）自动触发取消，取消后或过期后的重复点击无效；
    6. `session/load` 恢复期间标记 `replaying`，回放完成原子替换历史快照，回放中断保留旧快照并标记历史不完整。
- [x] **Step 2：实现 `projection.ts`、`approval-bridge.ts`、`session-manager.ts`**
  - 每个文件保持在 400 行以内，职责清晰解耦。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-session-manager.test.ts tests/antigravity-approval.test.ts tests/antigravity-history.test.ts && bun run typecheck`。

---

### Task 6（P2-A）：`AntigravityWebSource` 与 Web 后端路由/状态/列表集成

**Files:**
- Create: `src/antigravity/config.ts`
- Create: `src/antigravity/bootstrap.ts`
- Create: `src/web/sources/antigravity.ts`
- Modify: `src/config.ts`、`src/main.ts`
- Modify: `src/web/sources/types.ts`、`src/web/types.ts`
- Modify: `src/web/{http,operations,status,runtime,session-list,records}.ts`
- Create: `tests/web-antigravity-source.test.ts`
- Modify: `tests/web-http.test.ts`、`tests/web-operations.test.ts`、`tests/web-status.test.ts`

- [x] **Step 1：编写 `AntigravityWebSource` 与 HTTP 路由测试（TDD）**
  - 在 `tests/web-antigravity-source.test.ts` 与 `tests/web-http.test.ts` 中测试：
    1. `sessions()` 合并托管会话（`creationClient.kind = "sea_bridge"`，可读写）与 `Antigravity` 桌面端会话（`creationClient.kind = "desktop"`，`sendEnabled: false`），同 `sessionId` 去重且托管优先；
    2. `GET /api/sources/antigravity/models` 返回分离聚合后的基础模型与 `supportedReasoningEfforts`；
    3. `POST /api/sessions`（`source: "antigravity"`）支持同时传入 `modelId` 与 `reasoningEffort`；
    4. `POST /api/sessions/antigravity/:id/model` 支持空闲态传入 `{ modelId, reasoningEffort }`，对桌面只读会话或运行中会话返回 409；
    5. `POST /api/sessions/antigravity/:id/interrupt` 校验 `{ expectedExecutionId, expectedEpoch }`；
    6. `POST /api/sessions/antigravity/:id/approvals/:approvalId` 校验 CSRF、设备状态与 `{ optionId }` 并写审计日志；
    7. `src/web/session-list.ts` 支持按 `source=antigravity` 与 `creationClient` 过滤，`src/web/records.ts` 正确关联 Antigravity 会话标题。
- [x] **Step 2：实现 `AntigravityWebSource`、配置装配与 HTTP 路由扩展**
  - 通过 `src/antigravity/bootstrap.ts` 将 `src/main.ts` 的改动控制在 ~15 行以内。
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/web-antigravity-source.test.ts tests/web-http.test.ts tests/web-operations.test.ts tests/web-status.test.ts && bun run typecheck`。

---

### Task 7（P2-B）：Web 控制台前端接入（来源切换、模型+思考等级联动、桌面只读标识、在线审批与停止）

**Files:**
- Modify: `src/web/public/index.html`
- Modify: `src/web/public/app.css`
- Modify: `src/web/public/app.js`
- Modify: `tests/web-message-ui.test.ts`、`tests/web-ui-races.test.ts`

- [x] **Step 1：编写前端交互与竞态测试（TDD）**
  - 在 `tests/web-message-ui.test.ts` 与 `tests/web-ui-races.test.ts` 中覆盖：
    1. 切换到 `Antigravity` 来源时，新建页 `create-model` 与 `create-reasoning-effort` 联动（选择 `Gemini 4 Argon` 时默认选中 `medium` 且可切 `low/medium/high`；选择 `GPT-OSS 120B (Medium)` 时自动禁用思考等级下拉框）；
    2. 会话列表区分展示“SeaBridge 托管”与“Antigravity 桌面端（只读）”，选中桌面端只读会话时输入框禁用并提示只读原因；
    3. 托管会话出现 pending 权限请求时，渲染脱敏审批卡片（展示工具名、命令/路径与允许/拒绝按钮），点击后提交 `POST /api/sessions/antigravity/:id/approvals/:approvalId` 并防止重复点击；
    4. 托管会话运行中且 `executionControl.supported === true` 时，停止按钮提交 `{ expectedExecutionId, expectedEpoch }`；
    5. 空闲态托管会话支持修改模型与思考等级。
- [x] **Step 2：实现前端 UI 与状态同步**
  - 保持现有 DOM 安全渲染（`textContent`，不拼未转义 HTML）与 CSS 主题变量一致。
- [x] **Step 3：运行验证**
  - 执行 `node --check src/web/public/app.js && bun test tests/web-message-ui.test.ts tests/web-ui-races.test.ts`。

---

### Task 8（P2-C）：全量回归、构建与隔离环境实机验收

**Files:**
- Modify: `README.md`、`docs/deployment.md`（记录新增配置项与当前支持边界）

- [x] **Step 1：执行静态检查、针对性测试、Codex/dsh 回归与全量构建**
  ```bash
  bun run typecheck
  node --check src/web/public/app.js
  git diff --check

  bun test tests/antigravity-migrations.test.ts \
    tests/antigravity-transport.test.ts \
    tests/antigravity-model-catalog.test.ts \
    tests/antigravity-desktop-reader.test.ts \
    tests/antigravity-session-manager.test.ts \
    tests/antigravity-approval.test.ts \
    tests/antigravity-history.test.ts \
    tests/web-antigravity-source.test.ts

  bun test
  bun run build
  ```
- [x] **Step 2：在隔离目录执行最小实机闭环验收**
  - 验证 Web 端新建页“模型 + 思考等级”加载与选择、托管会话新建与两轮续聊、Web 在线审批、精确停止，以及 `Antigravity` 桌面端顶层会话列表与 `transcript.jsonl` 历史的只读展示（确认零 `.db` 写入、零额外隐式会话）。
