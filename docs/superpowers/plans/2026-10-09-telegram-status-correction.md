# Telegram Status Correction Implementation Plan

**Goal:** 已发送的中断通知被修正时只更新原消息。

**Architecture:** 投递阶段按纠正指纹查找同 chat/thread/turn 的中断回复映射，调用已有 editMessageText；原子完成 outbox 与回复映射更新。

**Tech Stack:** TypeScript, Bun, SQLite，现有 TelegramClient。

**Spec:** docs/superpowers/specs/2026-10-09-telegram-status-correction-design.md

## Global Constraints

不新增依赖，不提交或部署，编辑失败不补发；普通通知与 pending 替换保持原行为。

## Task 1: 纠正通知编辑投递

- [x] 扩充 tests/desktop-observer.test.ts 的已发送中断纠正用例：原 ID 77 被编辑，sendMessage 不被调用，回复映射更新为 completed。
- [x] 运行 `bun test tests/desktop-observer.test.ts`，确认失败来自新增消息而非编辑。
- [x] src/state/desktop-message-store.ts 新增精确中断映射查询，完成通知时仅允许相同 thread/turn 的中断映射升级。
- [x] src/desktop/desktop-observer.ts 识别纠正指纹，复用 editMessageText；400 message is not modified 当作成功，其他错误只安排重试。
- [x] 补测编辑失败、幂等编辑恢复、普通通知和未发送替换；运行 `bun run typecheck`、`bun test`、`bun run build`、`git diff --check`。
- [x] 自审范围、类型与隐私边界，记录验收结果；保留未提交分支供用户后续决定。

## 验收记录

- 分支：codex/telegram-status-correction，起始工作区干净。
- 定向测试 30 项通过；全量 434 项通过、0 失败；类型检查、构建、diff 检查通过。
- 项目未配置 lint/format 脚本，未安装额外工具。
- 自审：目标按 chat/thread/turn 隔离；编辑失败不新增消息；保留回复按钮与原 sent_at；纠正后的轮询不再次入队。
- 未提交、未推送、未部署，也未对真实 Telegram 发送或编辑测试消息。
