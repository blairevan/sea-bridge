# Telegram 终态纠正发布记录

## 授权与范围

用户授权提交、push、merge、部署；分支 codex/telegram-status-correction，版本 1.1.6。
复用原 Telegram 消息编辑状态纠正，编辑失败仅重试，保留回复映射与按钮；无新增依赖和数据库迁移。

## 编号清单

- [x] 1. 核验规则、特性分支、无冲突与无无关改动；Git 作者与上一提交一致，GitHub 账号与仓库所有者一致。
- [x] 2. 确认 TypeScript/Bun 工具链、版本递增及变更范围；不存在 CodeGraph 索引，项目没有独立 lint/format 脚本。
- [x] 3. 已尝试独立 Cursor 只读审查，超过 5 分钟未返回而停止；按技能备用路径语义复核并修复竞态，类型检查、测试、构建与 diff 验证通过。
- [ ] 4. 精确暂存，提交 fix(telegram-notifications): edit interrupted status corrections in place，并 push。
- [ ] 5. 创建 PR、核验账号/冲突/检查状态，Squash 合入 main；保留分支。
- [ ] 6. 从合并后的 main 构建发布快照，私有备份 SQLite 与旧 plist，切换 LaunchAgent。
- [ ] 7. 核验本机/公网版本、认证保护、运行进程与日志，保留可回退的旧快照。

## 验证命令

```bash
bun run typecheck
bun test tests/desktop-observer.test.ts tests/desktop-message-store.test.ts tests/codex-observer-store.test.ts
bun test
bun run build
git diff --check
```

真实 Telegram 端到端效果需要后续自然状态纠正事件核验，不主动给用户发测试通知。

## 发布前复核补充

- 复现并修复发送回执与 pending 替换并发：旧发送成功但原 outbox 已被纠正替换时仍保存原回复映射，避免完成纠正另发一条消息。
- SQLite 备份已生成；静态 WAL 备份采用 immutable 只读验收，quick_check 为 ok，管理员记录 1 个、设备会话 7 个。
- 最终验证：定向 31 pass，全量 435 pass、0 fail、1973 expect、66 files；typecheck/build/diff 检查通过。
- Cursor 独立审查未取得最终结论，不记为审查通过；备用语义复核未发现剩余阻断项。
