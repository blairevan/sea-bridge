# Design Spec: 直接回复自动匹配最近一次会话 (Direct Reply Auto-Matching)

- **Date**: 2026-09-25
- **Branch**: feature/direct-reply
- **Project**: sea-bridge
- **Status**: Approved

---

## 1. 目标与背景

在当前的 Sea-Bridge 实现中，Telegram 用户与 Codex 会话交互必须依赖 Telegram 的“回复 (Reply)”动作（即消息必须带有 `reply_to_message` 属性且该消息 ID 需在 `desktop_message_links` 中已建立映射）。

如果在 Telegram 中未点击回复按钮直接输入文字，系统将返回：
> "请回复某条 Sea-Bridge 会话通知，以选择要继续的 Codex 会话。"

为了降低用户的输入阻力、支持更自然的移动端连续对话，本项目需支持：
**当用户未显式点击回复时，系统自动匹配并关联当前聊天中最近一次收到通知的 Codex 会话，直接投递给该会话。**

---

## 2. 核心架构与方案

采用 **方案 1：基于当前聊天的最近一条已推送通知自动关联**。

### 2.1 数据查询能力扩展 (`DesktopMessageStore`)
在 `src/state/desktop-message-store.ts` 中新增 `findLatestLink(chatId: string): DesktopMessageLink | null` 方法：
- 检索条件：`telegram_chat_id = ?`
- 排序条件：`ORDER BY sent_at DESC, telegram_message_id DESC`
- 限制条数：`LIMIT 1`
- 查询性能：主键 `(telegram_chat_id, telegram_message_id)` 可用于按 `telegram_chat_id` 缩小扫描范围；`sent_at` 排序在当前单聊天低数据量场景下成本可控，如后续通知量显著增长再增加 `(telegram_chat_id, sent_at DESC, telegram_message_id DESC)` 复合索引。

### 2.2 路由适配改造 (`routeThreadReply`)
在 `src/telegram/thread-reply-router.ts` 中重构 link 定位逻辑：
1. 若存在 `message.reply_to_message`：
   - 维持既有逻辑，通过 `store.findLink(chatId, replyMessageId)` 精确匹配；
   - 若未匹配到，返回 `{ status: "unmapped_reply" }`。
2. 若不存在 `message.reply_to_message`（即直接回复）：
   - 调用 `store.findLatestLink(chatId)` 查找当前 Telegram Chat 最近一条 Sea-Bridge 映射消息；
   - 直接使用该 link 对应的 `threadId` 作为投递目标，并以 `link.messageId` 作为上下文记录推进投递；
   - **不判断该 Codex thread 当前是否 active / idle / completed，也不尝试重新选择“最近活跃会话”**；路由语义只取决于“该 Chat 最近一条已映射消息”；
   - 若未找到任何历史通知（全新聊天或无任何通知记录），则安全回退返回 `{ status: "missing_reply" }`。

### 2.3 幂等与交付状态追踪
- 无论通过显式回复还是直接回复触发，`beginDelivery` 与 `finishDelivery` 均基于 Telegram `update_id` 进行幂等拦截；
- 投递消息格式保持统一为 `[Telegram reply]\n${text}`，保证下游 Codex Desktop 协议的一致性。

---

## 3. 边界与异常处理

1. **全新会话/无通知历史**：
   - 返回 `{ status: "missing_reply" }`，保持原有友好提示。
2. **文本为空/白字符**：
   - 直接拦截并返回失败状态，不产生无效队列投递。
3. **并发重复请求**：
   - `telegram_thread_deliveries` 依托 SQLite 唯一主键与事务状态迁移（`received` -> `dispatching` -> `delivered`/`failed`），杜绝重复消费。

---

## 4. 验证与测试规范

1. **数据存储单测 (`tests/desktop-message-store.test.ts`)**：
   - `findLatestLink` 正确返回多条记录中最新插入的 link；
   - `findLatestLink` 在不同 `chatId` 下具备严格数据隔离；
   - `findLatestLink` 在无记录时返回 `null`。
2. **路由单测 (`tests/telegram-thread-reply-router.test.ts`)**：
   - 当 `reply_to_message` 缺失且存在历史 link 时，成功自动路由并投递；
   - 当 `reply_to_message` 缺失且无历史 link 时，返回 `missing_reply`；
   - 当显式回复未映射消息时，保持返回 `unmapped_reply`；
   - 幂等性断言：重复请求返回 `duplicate`。
3. **全量回归**：
   - 运行 `bun test`，确保全部现有与新增用例 100% 通过；
   - 运行 `bun run typecheck` 保持 0 类型错误。
