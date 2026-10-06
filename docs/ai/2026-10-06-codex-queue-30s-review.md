# v1.1.1 阈值调整提交前审查

Cursor Agent 在 `cursorcr-sea-bridge:30s-review` 中以只读 ask 模式完成。内置复核检查阈值共用、临界时刻、冷却/去重和文案；未发现阻断问题。

## Critical

无 Critical。

## Warning

无 Warning。

## Suggestion

无确定缺陷；以下为核对结论。

1. **`QUEUE_WAIT_MS` 三处一致**
   `src/desktop/codex-queue-recovery.ts` 中常量 `30_000` 用于：启动日志 `queueWaitMs`、首次候选 `now - createdAt <= QUEUE_WAIT_MS`、打开前复核 `now - pending.createdAt > QUEUE_WAIT_MS`。

2. **边界正确**
   年龄恰好 `30_000`：候选 `<=` 直接跳过；复核要求 `>`，不触发。
   `30_001`：两侧均通过，触发。与「超过 30 秒」文案一致。测试覆盖 `10_001` / `29_999` / `30_000` 不触发、`30_001` 触发。

3. **去重与冷却**
   同批 `attempted` 去重仍在；全局冷却仍为 `now - lastAttemptAt < 5000`。测试在 `40_000` 打开后，`44_999` 不触发另一线程，`45_000` 触发。

4. **文案与版本**
   README、设置页、顶部提示、设计文档均为 30 秒；`package.json` 为 `1.1.1`。成功提示的 `durationMs: 10_000` 是展示时长，不是队列阈值，无需改。


验证：`bun run typecheck`、`node --check src/web/public/app.js`、`git diff --check`、`bun run build` 通过；`bun test` 428 pass、0 fail、1902 expect。部署启动日志 queueWaitMs=30000，本机/公网资源与发布一致。
