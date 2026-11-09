# Antigravity ACP 桌面端与 CLI 原会话写入互通实施计划（Sub-plan 3：P4）

> **For agentic workers:** REQUIRED SUB-SKILL: Use `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- **Goal:** 基于 P4 隔离实测结论，实现当 `SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED=true` 时，在 Web 端与 Telegram 端对 `Antigravity.app`（桌面 2.0，`~/.gemini/antigravity`）原会话的安全按需接管与同 ID 续聊写入，同时保证：不产生导入副本、桌面端运行中拒绝并发写入（`session_busy`）、非允许项目目录保持只读、每轮结束后自动 `session/close` 并回收 worker 以释放 WAL 锁并恢复 `CASCADE_RUN_STATUS_IDLE`。
- **Architecture:** 在 `AntigravitySessionRecord` 中记录 `sessionOrigin: 'sea_bridge' | 'desktop'`；`AntigravitySessionManager` 按会话来源动态选择 `--app-data-dir`（托管会话用 `antigravity-cli`，桌面原会话用 `antigravity` 路径），在桌面会话每轮结束后主动释放 worker；`AntigravityDesktopReader` 提供 `inspectExternalSession` 检测桌面端实时运行状态与工作区归属，并增加 WAL 无 `-shm` 时的 `immutable=1` 只读回退与 `CORTEX_TRAJECTORY_SOURCE_CLI` 存根过滤。
- **Tech Stack:** Bun, TypeScript, `bun:sqlite`. 零新增第三方依赖。
- **Reference Spec:** [docs/superpowers/specs/2026-11-07-antigravity-acp-integration-design.md](../specs/2026-11-07-antigravity-acp-integration-design.md)（第 8.4、13-P4 节）及 [docs/ai/2026-11-09-antigravity-acp-poc.md](../../ai/2026-11-09-antigravity-acp-poc.md)（第 5 节）

---

## 1. 文件映射表（File Map）

| 文件路径 | 职责说明 |
| --- | --- |
| `src/antigravity/store.ts` | `AntigravitySessionRecord` 新增 `sessionOrigin?: "sea_bridge" | "desktop"` 字段，`antigravity_sessions` 表增加 `session_origin` 列（含存量表平滑 `ALTER TABLE` 补列）。 |
| `src/antigravity/desktop-reader.ts` | ① `openSummariesDb` 支持 `mode=ro` 遇到 `SQLITE_CANTOPEN` 时回退 `immutable=1`；② 过滤 `source = 'CORTEX_TRAJECTORY_SOURCE_CLI'` 存根记录；③ 新增 `inspectExternalSession(conversationId)` 返回桌面会话运行态（`externallyRunning`）、匹配项目（`projectId / cwd`）与标题。 |
| `src/antigravity/projection.ts` | `projectManagedWebSession` 保留 `session.sessionOrigin` 作为 `creationClient.kind`；支持将 `desktopReader` 的原生 `transcript.jsonl` 历史与已接管桌面会话的实时执行消息合并。 |
| `src/antigravity/session-manager.ts` | ① 支持按会话 `sessionOrigin` 选择 `--app-data-dir`（`desktop` 会话传入 `desktopAppDataDir`）；② 新增桌面原会话按需接管逻辑（校验 `externalSessionsEnabled`、非 `externallyRunning`、属于允许项目目录）；③ `desktop` 会话每轮结束自动调用 `closeSession` 并回收 worker 释放 WAL 写锁。 |
| `src/antigravity/bootstrap.ts` | 将 `desktopReader`、`externalSessionsEnabled` 与 `desktopAppDataDir` 注入 `AntigravitySessionManager`。 |
| `src/web/sources/antigravity.ts` | 当 `externalSessionsEnabled === true` 且桌面会话属于允许项目并处于空闲态时，开放 `sendEnabled: true`、`send`、`updateModel`，并合并展示桌面 `transcript.jsonl` 与实时流式消息。 |
| `tests/antigravity-p4-external-sessions.test.ts` | P4 全矩阵单元与集成测试（同 ID 接管续聊、按会话切换 `--app-data-dir`、桌面运行中 `session_busy` 拦截、越界目录只读保护、轮次结束回收 worker、Telegram 回复桌面会话端到端闭环、WAL `immutable=1` 回退与 CLI 存根过滤）。 |

---

## 2. 分步实施任务（Tasks）

### Task 1：扩展 `store.ts`、`desktop-reader.ts` 与 `projection.ts`

- [x] **Step 1：在 `store.ts` 中增加 `sessionOrigin` 持久化支持**
- [x] **Step 2：在 `desktop-reader.ts` 中实现 `immutable=1` 回退、`CORTEX_TRAJECTORY_SOURCE_CLI` 过滤与 `inspectExternalSession`**
- [x] **Step 3：在 `projection.ts` 中保留 `sessionOrigin` 并提供桌面历史与实时消息合并函数**

### Task 2：在 `session-manager.ts`、`bootstrap.ts` 与 `web/sources/antigravity.ts` 中打通桌面原会话写入

- [x] **Step 1：扩展 `AntigravitySessionManager` 支持按需接管桌面原会话、外部运行态互斥校验、按来源切换 `--app-data-dir` 及轮次后释放 worker**
- [x] **Step 2：更新 `bootstrap.ts` 与 `src/web/sources/antigravity.ts`**

### Task 3：编写 P4 专项测试并更新文档

- [x] **Step 1：编写并运行 `tests/antigravity-p4-external-sessions.test.ts`**
- [x] **Step 2：同步更新设计文档 `2026-11-07-antigravity-acp-integration-design.md`、`README.md` 与 `docs/deployment.md`**
- [x] **Step 3：执行全量回归、模块行数检查（单文件 ≤ 400 行）与隔离目录构建验证**
