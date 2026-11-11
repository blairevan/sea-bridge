# Antigravity `ask_question` 等待输入桥接、钉钉通知与 Web/Telegram 接管作答实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** 打通 Antigravity `ask_question` 等待用户输入状态在 Sea-Bridge（Web 控制台、Telegram Bot、`bridge.sock` 兼容层）与 Vibe Notch（macOS 刘海屏 `.waitingForInput` 状态机、钉钉独立通知）的全链路展示与直接接管作答，严格落实已确认的 `1A`（桌面端接管并发保护）、`2A`（Telegram 原地分页按钮向导 + 序号简写展开）与 `3C`（Vibe Notch `PreToolUse` Hook + 独立钉钉通知）决策。
- **Architecture:**
  1. 在 `sea-bridge` 中新增纯函数模块 `src/antigravity/question-parser.ts` 与 Telegram 交互模块 `src/antigravity/question-telegram-ui.ts`，并在 `src/antigravity/acp-worker-helpers.ts` 中封装桌面锁释放与 `1A` 并发保护预检，确保全部 `src/antigravity/*.ts` 模块严格保持 `<= 400` 行；
  2. 在 `external-history.ts` 与 `desktop-reader.ts` 中仅对运行态会话按需探测挂起 `ask_question`，分离输出前置说明正文与 `${stepId}-question` 问题卡片；在 `LocalBridgeService` 中将 `waiting_user_input` 向后兼容映射为 `waiting_external_approval` 以保护 `toolhub`；
  3. 在 `vibe-notch` 中为 `~/.gemini/config/hooks.json` 幂等注册 `PreToolUse (matcher: "ask_question")`，经 `antigravity_bridge.py` 驱动 `SessionStore` 切换 `.waitingForInput`，并由独立的 `AntigravityQuestionNotificationFormatter.swift` 渲染钉钉问题通知。
- **Tech Stack:**
  - `sea-bridge`: Bun, TypeScript, `bun:sqlite`, Vanilla JS/CSS（零新增第三方依赖，版本号自 `v1.5.0` 递增为 `v1.6.0`）。
  - `vibe-notch`: Swift 5.9 / SwiftUI / AppKit, Python 3 标准库（零新增第三方依赖）。
- **Reference Spec:** [docs/superpowers/specs/2026-11-11-antigravity-ask-question-bridge-design.md](../specs/2026-11-11-antigravity-ask-question-bridge-design.md)

---

## 1. 工作区隔离与执行策略（Execution Method）

1. **`vibe-notch`（`/opt/app/aitools/vibe-notch`）**：
   - 当前仓库处于干净 `main` 分支，直接创建功能分支 `feat/antigravity-ask-question-notify` 实施并运行 Python 与 `xcodebuild test` 全量测试。
2. **`sea-bridge`（`/opt/app/aitools/sea-bridge`）**：
   - 鉴于并发会话 `feat/execution-source-cli-desktop`（`v1.5.0`）正在使用主工作区，实施前先检查 `git status -sb`：
     - 若 `feat/execution-source-cli-desktop` 已完成提交：直接基于该最新提交切出功能分支 `feat/antigravity-ask-question-bridge`；
     - 若主工作区仍存在未提交改动：使用 `git worktree add` 在 `/Users/zhuhaijun/.devspace/worktrees/sea-bridge-ask-question` 创建隔离工作树（同步 `v1.5.0` 基线），零冲突完成开发与全量门禁验证，待主工作区提交后再平滑合并回仓库。

---

## 2. 文件映射表（File Map）

### 2.1 `sea-bridge` 仓库

| 文件路径 | 操作 | 职责说明（控制单文件 `<= 400` 行） |
| --- | --- | --- |
| `src/web/sources/types.ts` | 修改 | `WebQuestionPrompt` 新增 `multiSelect?: boolean`；`WebSession["state"]` 新增 `"waiting_user_input"`；`WebSource.send` 新增可选 `SendOptions`（`forceDesktopTakeover?: boolean`）。 |
| `src/antigravity/question-parser.ts` | 新建 | 解析 `ask_question`（兼容数组与 JSON 字符串双形态）、尾部挂起探测 `inspectPendingAskQuestion`、`formatAntigravityQuestionAnswers`（单题原文 / 多题 `A1..AN`）、`expandQuestionShorthandReply`（`1 1 1 1`、`1+2 3` 展开与自由文本回退）。 |
| `src/antigravity/external-history.ts` | 修改 | 水合末尾 `PLANNER_RESPONSE` 的 `ask_question`，分离推入 `${stepId}-assistant` 正文与 `${stepId}-question` 卡片，剔除 `activeTurnItems` 中冗余 `"ask_question"`。 |
| `src/antigravity/desktop-reader.ts` | 修改 | `ExternalSessionInspection` 增加 `waitingUserInput: boolean`；仅对 `isRunning` 行按需探测 `inspectPendingAskQuestion` 并投影 `state: "waiting_user_input"`。 |
| `src/antigravity/desktop-app-controller.ts` | 修改 | 新增 `markReopenAfterTurn(sessionId, chatId?)`，在接管前已主动退出 `Antigravity.app` 的场景下，待后台轮次落盘且无冲突时调用 `reopenDesktopApp(sessionId)` 自动恢复桌面端。 |
| `src/antigravity/acp-worker-helpers.ts` | 修改 | 新增 `prepareDesktopQuestionTakeover` 封装桌面锁检查、`hasOtherRunningDesktopSession` 并发保护（返回 `desktop_takeover_confirm_required`）与 `quitDesktopApp` 锁释放，保持 `session-manager.ts <= 400` 行。 |
| `src/antigravity/session-manager.ts` | 修改 | `resolveOrAdoptSession` 放行 `waitingUserInput === true` 的外部会话；`send` 接入 `prepareDesktopQuestionTakeover` 并透传 `SendOptions`；注入 `desktopAppController`。 |
| `src/antigravity/bootstrap.ts` | 修改 | 将 `desktopAppController` 注入 `AntigravitySessionManager`，并把 Telegram 强制接管/向导回调接入 `AntigravityTelegramHandler` 与 `AntigravityDesktopObserver`。 |
| `src/web/operations.ts` & `src/web/http.ts` | 修改 | `WebWriteRequest` 与 `POST /api/sessions/:source/:id/messages` 支持 `forceDesktopTakeover?: boolean`；`GET /api/sessions?activity=...` 白名单支持 `"waiting_user_input"`。 |
| `src/web/sources/antigravity.ts` | 修改 | 对 `waitingUserInput` 会话（含已收编与未收编外部会话）投影 `state: "waiting_user_input"` 与 `sendEnabled: canWrite`，透传 `send` 的 `options`。 |
| `src/bridge/service.ts` | 修改 | `getSessionSummary` 将 `"waiting_user_input"` 向后兼容映射为 `"waiting_external_approval"`（`pendingApprovalsCount >= 1`），保护 `toolhub` 契约。 |
| `src/antigravity/telegram-store.ts` | 修改 | 暴露轻量受控键值读写 `getCustomState` / `setCustomState`（复用 `cleanupTransientState` 过期清理），保持文件 `<= 400` 行。 |
| `src/antigravity/question-telegram-ui.ts` | 新建 | 封装 Telegram `❓ Antigravity 等待输入` 消息排版、单题一键按钮、多题/多选原地分页向导（`q.pick` / `q.toggle` / `q.page` / `q.submit`）、`qmeta` 关联及 `desktop_takeover_confirm_required` 强制接管确认按钮（`q.force_submit` / `q.cancel_force`）。 |
| `src/antigravity/desktop-observer.ts` | 修改 | 在 `observeDesktopSessions` / `deliverPending` 中委托 `question-telegram-ui.ts` 实时入箱与渲染问题向导按钮，终态游标忽略空文本 `-question` 消息。 |
| `src/antigravity/reply-router.ts` & `src/antigravity/telegram-handler.ts` & `src/main.ts` | 修改 | `reply-router` 支持基于 `qmeta` 展开序号简写并返回 `desktop_takeover_confirm_required`；`telegram-handler` 与 `main.ts` 处理向导回调与文本回复冲突确认提示。 |
| `src/web/public/index.html`、`app.js`、`styles.css`、`package.json`、`docs/ai/web-console-versioning.md` | 修改 | Web 端新增 `等待输入` 状态徽标与筛选器、`renderQuestionCard` 多选复选框 + 逐题“其他（自定义输入）” + `A1..AN` 组装、`desktop_takeover_confirm_required` 二次确认重试；升级应用版本至 `1.6.0` 并更新版本记录。 |
| `tests/antigravity-question-parser.test.ts`、`tests/antigravity-desktop-takeover.test.ts`、`tests/antigravity-question-telegram.test.ts`、`tests/web-question-card.test.ts` | 新建 | 覆盖解析器、桌面锁接管 `1A` 保护、Telegram 分页向导与简写 `2A`、Web 多选/自定义卡片及 `bridge.sock` 兼容映射。 |

### 2.2 `vibe-notch` 仓库

| 文件路径 | 操作 | 职责说明 |
| --- | --- | --- |
| `ClaudeIsland/Resources/antigravity_bridge.py` | 修改 | 支持 `PreToolUse` 事件，仅当 `toolCall.name == "ask_question"` 时提取结构化 `questionPrompt`（兼容数组与 JSON 字符串），向 Socket 发送 `status: "waiting_for_input"`，标准输出恒为 `{}`。 |
| `ClaudeIsland/Services/Hooks/AntigravityHookInstaller.swift` | 修改 | 在 `~/.gemini/config/hooks.json` 中幂等合并注册 `PreToolUse`（`matcher: "ask_question"`），并更新健康检查断言。 |
| `ClaudeIsland/Models/AntigravitySession.swift` | 修改 | 新增 `AntigravityQuestionItem`、`isWaitingForUserInput`、`pendingQuestionID`（`conversationId:generation:q:stepIdx`）与 `pendingQuestions`。 |
| `ClaudeIsland/Services/State/SessionStore.swift` | 修改 | 解析 `antigravity.questionPrompt` 与 `waiting_for_input`，映射 `session.phase = .waitingForInput`，并在后续 `PostToolUse / PreInvocation / UserPromptSubmit / Stop` 时自动复位。 |
| `ClaudeIsland/Services/DingTalk/AntigravityQuestionNotificationFormatter.swift` | 新建 | 纯函数构造 `### ❓ Vibe Notch - 等待确认问题` 钉钉 Markdown 标题与正文（含 `Q1..QN` 单选/多选标识、选项列表及安全长度截断）。 |
| `ClaudeIsland/Services/DingTalk/DingTalkNotificationCoordinator.swift` | 修改 | 新增独立去重集合 `notifiedAntigravityQuestionIDs`，在会话进入待输入问题态时异步补齐上下文并调用 `AntigravityQuestionNotificationFormatter` 推送钉钉通知。 |
| `scripts/tests/test_antigravity_bridge.py` & `ClaudeIslandTests/*` | 修改/新建 | 补充 Python `PreToolUse` 单测与 Swift `AntigravityHookInstaller`、`SessionStore`、`DingTalkNotificationCoordinator` 单元测试。 |

---

## 3. 分步实施任务（Tasks）

### Task 1：`vibe-notch` — Antigravity `PreToolUse (ask_question)` 桥接、刘海屏状态机与钉钉通知（决策 `3C`）

- [x] **Step 1（TDD 红灯）**：在 `scripts/tests/test_antigravity_bridge.py` 新增 `PreToolUse (ask_question)`（数组与 JSON 字符串参数、非 `ask_question` 忽略、stdout `{}`）测试；在 `ClaudeIslandTests` 新增 `AntigravityHookInstaller` `PreToolUse` 幂等合并测试、`SessionStore` `.waitingForInput` 流转测试与 `DingTalkNotificationCoordinator` 独立 `pendingQuestionID` 去重通知测试，运行确认失败。
- [x] **Step 2（实现 Hook 与 Python 桥接）**：修改 `ClaudeIsland/Resources/antigravity_bridge.py` 与 `ClaudeIsland/Services/Hooks/AntigravityHookInstaller.swift`，支持 `PreToolUse (matcher: "ask_question")`。
- [x] **Step 3（实现刘海屏状态与钉钉通知）**：修改 `AntigravitySession.swift`、`SessionStore.swift`，新建 `AntigravityQuestionNotificationFormatter.swift` 并接入 `DingTalkNotificationCoordinator.swift`。
- [x] **Step 4（全量验证）**：运行 `PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts/tests -q` 与 `xcodebuild test -scheme ClaudeIsland -configuration Debug -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO`，确认 0 失败。

### Task 2：`sea-bridge` — `ask_question` 解析器、外部轨迹水合与 `bridge.sock` 兼容层

- [x] **Step 1（TDD 红灯）**：新建 `tests/antigravity-question-parser.test.ts`，覆盖数组/字符串 `args.questions`、`transcript_full.jsonl` 截断水合、空正文 `PLANNER_RESPONSE`、前置说明正文保留、历史已作答步骤不误判、单题/多题 `A1..AN` 组装、数字简写（`1 1 1 1`、`1+2 3`）展开与自由文本回退。
- [x] **Step 2（实现解析与读取投影）**：扩展 `src/web/sources/types.ts`，新建 `src/antigravity/question-parser.ts`，更新 `src/antigravity/external-history.ts`、`src/antigravity/desktop-reader.ts`、`src/web/sources/antigravity.ts` 与 `src/bridge/service.ts`。
- [x] **Step 3（验证）**：运行 `bun test tests/antigravity-question-parser.test.ts` 与既有 `desktop-reader` / `bridge` 测试，确认全部通过。

### Task 3：`sea-bridge` — 桌面端排他锁释放与 `1A` 并发保护接管写链路

- [x] **Step 1（TDD 红灯）**：新建 `tests/antigravity-desktop-takeover.test.ts`，覆盖：① 无其他 `running` 桌面会话时自动 `quitDesktopApp -> session/resume -> prompt -> onDesktopTurnSettled reopenDesktopApp`；② 存在其他 `running` 桌面会话且未传 `forceDesktopTakeover` 时返回 `desktop_takeover_confirm_required` 且不退出桌面端；③ 其他桌面会话处于 `idle` 或 `waiting_user_input` 时不误报冲突；④ 传入 `forceDesktopTakeover: true` 强制接管成功；⑤ CLI `waiting_user_input` 会话接管绝不退出 `Antigravity.app`。
- [x] **Step 2（实现接管与 HTTP/Operations 透传）**：更新 `src/antigravity/desktop-app-controller.ts`、`src/antigravity/acp-worker-helpers.ts`、`src/antigravity/session-manager.ts`、`src/antigravity/bootstrap.ts`、`src/web/operations.ts` 与 `src/web/http.ts`。
- [x] **Step 3（验证）**：运行 `bun test tests/antigravity-desktop-takeover.test.ts tests/antigravity-session-manager.test.ts tests/antigravity-desktop-app-controller.test.ts`。

### Task 4：`sea-bridge` — Telegram 实时提问通知、原地分页按钮向导与序号简写回复（决策 `2A`）

- [x] **Step 1（TDD 红灯）**：新建 `tests/antigravity-question-telegram.test.ts`，覆盖实时 `waiting_user_input` 入箱去重（不干扰终态游标）、单题一键投递、多题/多选原地 `editMessageReplyMarkup` 翻页与勾选提交、`💬 回复` ForceReply 数字简写展开、以及 `desktop_takeover_confirm_required` 触发 `[⚠️ 强制重启桌面端并提交]` / `[✖️ 取消]` 闭环。
- [x] **Step 2（实现 Telegram 向导与回复路由）**：更新 `src/antigravity/telegram-store.ts`，新建 `src/antigravity/question-telegram-ui.ts`，接入 `src/antigravity/desktop-observer.ts`、`src/antigravity/reply-router.ts`、`src/antigravity/telegram-handler.ts` 与 `src/main.ts`。
- [x] **Step 3（验证）**：运行 `bun test tests/antigravity-question-telegram.test.ts tests/antigravity-desktop-observer.test.ts tests/antigravity-telegram-routing.test.ts`。

### Task 5：`sea-bridge` — Web 控制台 `等待输入` 状态、多选/自定义问题卡片与二次确认 + 全量门禁

- [x] **Step 1（TDD 红灯）**：新建 `tests/web-question-card.test.ts`，覆盖 `waiting_user_input` 状态徽标与筛选器、多选题复选框切换、逐题“其他（自定义输入）”、多题 `A1..AN` 提交、Codex 单选卡片回归兼容，以及 `desktop_takeover_confirm_required` 二次确认携带新 `operationId` + `forceDesktopTakeover: true` 重试。
- [x] **Step 2（实现前端与版本升级）**：更新 `src/web/public/index.html`、`src/web/public/app.js`、`src/web/public/styles.css`，将 `package.json` 版本升至 `1.6.0` 并更新 `docs/ai/web-console-versioning.md`。
- [x] **Step 3（全量门禁与模块行数核验）**：
  - 校验所有 `src/antigravity/*.ts` 文件行数均 `<= 400` 行；
  - 在 `sea-bridge` 运行：`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`bun test`、`git diff --check`；
  - 在 `vibe-notch` 复核 Python 与 `xcodebuild test` 全量通过。
