# 任务复盘与经验沉淀卡片 (Retrospective Card)

- **任务主题**：【Sea-Bridge】直接回复自动匹配最近一次会话
- **交付日期**：2026-09-25
- **关联 PR**：https://github.com/blairevan/sea-bridge/pull/1
- **关联飞书文档**：https://my.feishu.cn/docx/BKvMd9uGRo8qVdxIwyEcbG64nvd (条目 2)

---

### 1. 问题表象与真实根因 (Root Cause)
- **表象**：Telegram 用户在手机私聊中直接打字发送指令时，Sea-Bridge 报错拦截并提示：“请回复某条 Sea-Bridge 会话通知，以选择要继续的 Codex 会话。”
- **根因**：原路由逻辑 `routeThreadReply` 强依赖 Telegram 消息对象的 `reply_to_message` 属性，未提供平滑回退匹配机制；在私聊单聊场景下，用户最自然的交互是直接输入，每次都要求用户长按或滑动「回复」造成交互摩擦。

---

### 2. 核心解决策略与关键决策 (Key Trade-offs)
- **设计决策**：采用以当前 Telegram 聊天（Chat）的历史通知时间序（`sent_at DESC, telegram_message_id DESC LIMIT 1`）作为关联基准（方案 1）。
- **权衡分析**：
  - 放弃“限制 24 小时超时窗口”（方案 2），避免给用户引入非预期的硬性过期阻断；
  - 放弃“桌面当前活跃窗口对齐”（方案 3），避免桌面端切换无关工程时意外覆盖移动端意图；
  - 保留“聊天未曾产生任何通知”时的原有 `missing_reply` 提示，确保零历史时的边界优雅。

---

### 3. 踩坑点与工程防线 (Pitfalls & Gotchas)
1. **多 Profile / 租户权限隔离**：
   - 飞书企业账号（Profile: `cli_aa138d8a0b79dd05`）与个人私有文档（Profile: `personal`）具有不同租户空间；
   - 跨租户文档读取/写入时会报 `3380004` 权限错误；
   - **防线建立**：升级 `feishu_docs.md` 标注 `profile: personal` / `profile: default`，并在 `sea-issue-resolver` 技能中建立域名与标注的自动 Profile 切换门禁。
2. **幂等上下文复用**：
   - 直接回复虽然在 Telegram 侧没有 `reply_to_message_id`，但 `telegram_thread_deliveries` 记录必须关联真实通知消息；
   - **防线建立**：以匹配到的 `link.messageId` 自动充当 `reply_to_message_id`，保持外键关联与幂等防重机制 100% 生效。

---

### 4. 长期预防机制 (Prevention & Verification)
- **新增单元测试矩阵**：
  - `DesktopMessageStore.findLatestLink`：覆盖时间倒序排序、多聊天隔离与空记录状态；
  - `routeThreadReply`：覆盖直接回复成功投递、无通知历史回退报错、显式未映射回复报错三类核心路径；
- **CI / 本地门禁**：
  - 维持 31 个测试用例 100% 自动回归通过，`bun run typecheck` 保持 0 类型警告。


### 5. 增量迭代 (2026-09-25 追加优化)
- **需求**：投递成功提示文案由固定文案改为包含会话真实标题：`已投递到对应的 Codex Desktop 会话：{会话标题}`
- **关联 PR**：https://github.com/blairevan/sea-bridge/pull/2
- **测试验证**：单测矩阵扩展为 32 个，新增 `tests/telegram-service.test.ts` 端到端会话标题动态拼装断言。
