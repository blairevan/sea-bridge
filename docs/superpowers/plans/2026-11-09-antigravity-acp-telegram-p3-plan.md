# Antigravity ACP Telegram 全能力接入实施计划（Sub-plan 2：P3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** 在已完成 Sub-plan 1（P0–P2 Web MVP）的基础上，完成 Antigravity P3 阶段 Telegram 全能力接入：实现 `/agy_status`、`/agy_projects`、`/agy_model`（基础模型 + 思考等级 `Effort` 分离选择）、`/agy_new`（分页菜单 / `ForceReply` / 快捷直建）、`codex / dsh / antigravity` 三方回复路由与冲突保护、托管会话与 `Antigravity` 桌面端只读会话通知观察器（含 `antigravity_outbox` 去重、429 退避、未知状态 quarantine），以及 Web 与 Telegram 双端共享的实时工具权限审批。
- **Architecture:** 通过 `src/antigravity/telegram-handler.ts` 封装 `/agy_*` 命令与 `agy:<token>` 回调处理，`src/telegram/service.ts` 仅做薄委托，确保所有新增模块单文件 ≤ 400 行；通过 `src/antigravity/bootstrap.ts` 在 Web 与 Telegram 之间共享同一套 `AntigravityStore`、`AntigravitySessionManager` 与 `AntigravityApprovalBridge` 实例，实现双端审批先决生效与按钮自动清除。
- **Tech Stack:** Bun, TypeScript, `bun:sqlite`, Telegram Bot API。零新增第三方依赖。
- **Reference Spec:** [docs/superpowers/specs/2026-11-07-antigravity-acp-integration-design.md](../specs/2026-11-07-antigravity-acp-integration-design.md)（第 10.1、11.2、13-P3、14.1、14.2 节）

---

## 1. 文件映射表（File Map）

| 文件路径 | 职责说明 |
| --- | --- |
| `src/antigravity/telegram-store.ts` | 封装 `antigravity_message_links`、`antigravity_telegram_state`、`antigravity_outbox` 的持久化操作（消息映射、跨三方最新可回复消息查询、按 chat 模型+思考等级偏好、一次性 TTL 回调 token、`/agy_new` 待输入 `ForceReply` 状态、按 `update_id` 幂等的创建/回复账本、观察器游标与 outbox 状态机）。 |
| `src/antigravity/menu-ui.ts` | 生成 `agy:<token>` 回调、渲染 `/agy_new` 项目分页菜单、渲染 `/agy_model` 模型与思考等级（`low / medium / high`）同屏联动菜单、格式化并分片脱敏轮次终态通知。 |
| `src/antigravity/new-session-manager.ts` | 管理 Telegram 端项目查询、模型+思考等级偏好校验、`ForceReply` 待输入生命周期，以及按 `telegram_update_id` 幂等创建托管会话并发送首轮 prompt。 |
| `src/antigravity/reply-router.ts` | 处理 Telegram 引用回复、`💬 回复` 按钮与无引用最新通知投递；拦截 `Antigravity` 桌面端只读会话回复（返回 `desktop_read_only`）；按 `telegram_update_id` 幂等派发并映射 `session_busy` / `delivery_unknown`。 |
| `src/antigravity/desktop-observer.ts` | 负责：① 托管会话轮次终态通知入队；② `Antigravity` 桌面端会话只读轮询观察（启动建立 baseline 不补发旧通知，新完成轮次入队且只读模式下不挂回复按钮）；③ `antigravity_outbox` 顺序投递、429 指数退避与超时 quarantine；④ Web/Telegram 共享 `AntigravityApprovalBridge` 审批消息发送与按钮自动清除。 |
| `src/antigravity/telegram-handler.ts` | 统一处理 `/agy_status`、`/agy_projects`、`/agy_model`、`/agy_new` 命令、`agy:<token>` 回调与 `/agy_new` 的 `ForceReply` 回复，供 `TelegramService` 薄调用。 |
| `src/antigravity/bootstrap.ts` | 提升核心组件（`store`、`capabilityGate`、`modelCatalog`、`approvalBridge`、`desktopReader`、`sessionManager`）为运行时共享单例，同时暴露 `createWebSource` 与 `createTelegramComponents`。 |
| `src/telegram/provider-reply-router.ts` | 扩展为 `codex / dsh / antigravity` 三方回复路由，支持联合查询最新通知、检测任意多来源映射冲突（`provider_conflict`）及识别 `antigravity_desktop_read_only`。 |
| `src/telegram/service.ts` | 注册 `/agy_*` 命令说明，薄委托 `AntigravityTelegramHandler` 处理命令、回调与三方 `ForceReply` 冲突校验，接入三方 `routeProviderReply`。 |
| `src/state/dsh-bridge-store.ts` | `findLatestReplyMessageId` 纳入 `antigravity_message_links` 联合查询。 |
| `src/web/records.ts` | 将 Telegram 端产生的 Antigravity 投递记录纳入 `/api/operations` 诊断视图。 |
| `src/main.ts` | 将 `antigravityRuntime.createTelegramComponents(...)` 接入 `TelegramService` 与生命周期启停。 |

---

## 2. 分步实施任务（Tasks）

### Task 1（P3-A）：Telegram 状态存储与菜单/通知格式化（`telegram-store.ts` & `menu-ui.ts`）

**Files:**
- Create: `src/antigravity/telegram-store.ts`
- Create: `src/antigravity/menu-ui.ts`
- Modify: `src/state/dsh-bridge-store.ts`
- Create: `tests/antigravity-telegram-store.test.ts`

- [x] **Step 1：编写 `AntigravityTelegramStore` 与 `menu-ui` 单元测试（TDD）**
  - 覆盖：
    1. 一次性 callback token 的 chat 绑定、TTL 过期与单次消费；
    2. 按 chat 保存与读取 `{ modelId, reasoningEffort }` 偏好；
    3. `/agy_new` `ForceReply` 待输入状态的创建、单次消费与过期判定；
    4. 按 `update_id` 幂等的创建请求（`received -> dispatching -> accepted -> acknowledged`）与回复投递账本，以及重启后 `dispatching -> delivery_unknown` 恢复；
    5. 托管会话与桌面会话观察器 baseline 游标、outbox 去重入队、完成时原子写入 `antigravity_message_links`（区分 `sea_bridge` 与 `desktop`）、429 失败重试与 quarantine；
    6. `renderAntigravityModelMenu` 对多档位模型渲染 `low / medium / high` 切换按钮、对单档位模型（`gpt-oss-120b-medium`）标记思考等级固定不可调；
    7. `formatAntigravityTerminal` 对长回答安全分片与敏感信息脱敏。
- [x] **Step 2：实现 `src/antigravity/telegram-store.ts`、`src/antigravity/menu-ui.ts` 并更新 `findLatestReplyMessageId`**
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-telegram-store.test.ts tests/dsh-bridge-store.test.ts`。

---

### Task 2（P3-B）：Telegram 新建会话管理器与回复路由器（`new-session-manager.ts` & `reply-router.ts` & `provider-reply-router.ts`）

**Files:**
- Create: `src/antigravity/new-session-manager.ts`
- Create: `src/antigravity/reply-router.ts`
- Modify: `src/telegram/provider-reply-router.ts`
- Create: `tests/antigravity-telegram-routing.test.ts`

- [x] **Step 1：编写新建会话与三方回复路由测试（TDD）**
  - 覆盖：
    1. `/agy_new` 通过序号、ID 或名称匹配项目，应用 chat 保存的 `(modelId, reasoningEffort)` 创建托管会话；相同 `update_id` 重复投递返回 `duplicate` 不创建第二个会话；不同 payload 相同 `update_id` 返回 `duplicate_payload_mismatch`；
    2. `AntigravityReplyRouter` 对托管会话（`sea_bridge`）正常投递回复、运行中返回 `session_busy`、断连返回 `delivery_unknown`；对桌面端只读会话（`desktop` 且 `externalSessionsEnabled === false`）返回 `desktop_read_only`；
    3. `routeProviderReply` 支持 `codex / dsh / antigravity` 三方精确引用回复与无引用最新通知路由；当同一 `(chatId, messageId)` 在任两方同时存在映射时返回 `provider_conflict`。
- [x] **Step 2：实现 `new-session-manager.ts`、`reply-router.ts` 并扩展 `provider-reply-router.ts`**
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-telegram-routing.test.ts tests/telegram-thread-reply-router.test.ts`。

---

### Task 3（P3-C）：托管/桌面会话通知观察器与 Web+Telegram 共享审批（`desktop-observer.ts`）

**Files:**
- Create: `src/antigravity/desktop-observer.ts`
- Modify: `src/antigravity/session-manager.ts`
- Create: `tests/antigravity-observer-approval.test.ts`

- [x] **Step 1：编写观察器与双端共享审批测试（TDD）**
  - 覆盖：
    1. 托管会话轮次完成（`completed / cancelled / incomplete / failed`）后生成脱敏通知并通过 Telegram 发送，附带 `💬 回复` 按钮，且原子写入 `antigravity_message_links(session_origin='sea_bridge')`；
    2. `Antigravity` 桌面端存量会话首次扫描仅建立 baseline 游标，不补发历史通知；后续产生新完成轮次时推送 `Antigravity 桌面端（只读）` 通知（不带 `💬 回复` 按钮，写入 `session_origin='desktop'`）；
    3. Telegram 发送返回 429 时按指数退避更新 `next_attempt_at`；发送超时或断连时进入 `quarantined` 绝不自动重发；
    4. Web 与 Telegram 共享同一条 `antigravity_approvals` pending 记录：当 `requestPermission` 触发时向 Telegram 发送带选项按钮的审批卡片；若用户在 Telegram 点击允许/拒绝，或先在 Web 端完成审批，或超时/取消，均只生效一次并自动调用 `editMessageReplyMarkup` 清除 Telegram 按钮。
- [x] **Step 2：实现 `src/antigravity/desktop-observer.ts` 并联动 `session-manager.ts`**
- [x] **Step 3：运行验证**
  - 执行 `bun test tests/antigravity-observer-approval.test.ts`。

---

### Task 4（P3-D）：Telegram 命令/回调处理器、主流程装配与全量回归（`telegram-handler.ts`、`service.ts`、`bootstrap.ts`、`main.ts`）

**Files:**
- Create: `src/antigravity/telegram-handler.ts`
- Modify: `src/antigravity/bootstrap.ts`
- Modify: `src/telegram/service.ts`
- Modify: `src/web/records.ts`
- Modify: `src/main.ts`
- Modify: `README.md`、`docs/deployment.md`
- Create: `tests/antigravity-telegram-handler.test.ts`

- [x] **Step 1：编写 `AntigravityTelegramHandler` 与 `TelegramService` 端到端集成测试（TDD）**
  - 覆盖：
    1. `/agy_status`、`/agy_projects`、`/agy_model`（切换模型、切换 `low/medium/high` 思考等级、恢复默认模型）、`/agy_new`（无参弹出菜单 -> 点选项目触发 `ForceReply` -> 回复创建会话；以及 `/agy_new 1 需求` 一步直建）；
    2. `codex / dsh / antigravity` 三方 `ForceReply` pending prompt 冲突拦截；
    3. 点击通知上的 `💬 回复` 按钮弹出 `ForceReply` 并精确续聊；引用桌面只读通知返回只读提示；
    4. 点击 Telegram 审批按钮完成审批并清除按钮。
- [x] **Step 2：实现 `telegram-handler.ts`，更新 `bootstrap.ts`、`service.ts`、`records.ts`、`main.ts` 及文档**
- [x] **Step 3：执行全量回归与构建验证**
  - 执行 `bun run typecheck && node --check src/web/public/app.js && git diff --check && bun test` 与隔离目录构建验证。
