# Codex 排队诊断日志（v0.6.1）

## 范围

Sea-Bridge 只负责投递并只读观察，不重试投递、不启动原生队列、不修改 Codex 数据库。诊断不记录消息正文、附件、CLI 参数、标准输出/错误内容或凭证。

## 日志链路

- `codex_queue_submit_started/result`：deliveryId、来源 web/telegram、Telegram updateId、threadId、消息长度、CLI 耗时/退出码/信号、原生 queueItemId。退出成功只说明入队，不代表开始执行。
- `codex_queue_receipt_observed/item_seen/item_changed/item_left`：queueItemId、clientMessageId、原生时间、观察时间；队列移出不等于执行。
- `codex_queue_execution_observed`：原生 UserMessage.client_id 精确匹配 turnId，及开始/结束时间。
- `codex_turn_terminal_observed`：实际完成/中断的 threadId、turnId、时间，与 Telegram 通知发送独立。
- `codex_queue_waiting_long`：排队超过两分钟，之后每五分钟重复。包含队列位置/深度、最近任务状态/时间、待审批、Hook 元数据、Desktop/直属 Codex 子进程 PID、rollout 打开进程。
- `codex_queue_read_unavailable/recovered`：区分 SQLite_BUSY、缺失、结构不兼容等读取故障；读取失败或截断不推断移出队列。
- `codex_queue_observer_health/observation_gap`：每五分钟观察心跳；轮询间隔超过三十秒记录间断。墙钟变化也可能造成间断。

每十秒只读扫描队列，最多读取五百条、跟踪一千条。仅长等待或队列移出时读取有边界的 rollout（最多16MB），进程检查有一秒超时。重启后恢复观察原生待处理队列，旧投递 deliveryId 不保证恢复；原生 queueItemId/clientMessageId 保持可关联。

没有精确 client_id 匹配时不声称消息执行；移出两分钟仍无法匹配，记录 execution_unconfirmed。rollout 无打开句柄只是线索，不能证明未加载；nativeLockState 明确为 unobserved。

## 下次出现时

记录手机上的会话、发送时间和恢复时间。可先保留卡住状态，再打开 Codex，比较前后队列/执行事件。查询两个日志文件：

```bash
rg 'codex_queue_|codex_turn_terminal_observed' ~/Library/Logs/sea-bridge.log ~/Library/Logs/sea-bridge.error.log
```

按 threadId 定位，接着用 queueItemId/clientMessageId/turnId 串联投递、入队、消费及执行证据。INFO 在 stdout，WARN/ERROR 在 stderr。

## 验证与发布

- `bun run typecheck`：通过。
- `bun test`：310 pass、0 fail，覆盖精确关联、读取失败/截断、告警节流、观察间断、停止排空、隐私及既有业务。
- `bun run build`、`git diff --check`：通过。项目没有 lint/format 命令。
- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.6.1-20261003-173703`，运行 PID 89260；保留旧发布及 rollback/plist、0600 SQLite 一致性备份，quick_check=ok。
- `launchctl print gui/501/com.aitools.sea-bridge` 与 `lsof -nP -iTCP:7310 -sTCP:LISTEN`：running，仅监听127.0.0.1:7310。
- Python urllib 检查127.0.0.1、100.112.22.85的首页及 v0.6.1 JS/CSS：全部200且字节匹配发布；未认证API为401；dsh_connected 已确认。
- 运行日志已捕获长空闲临时测试消息：17:21:42成功入队，17:37仍存在，最近任务idle、无待审批、rollout句柄为空。测试曾归档/恢复，不能等同原故障，尚不能定性锁或调度缺陷。
- 没有 commit/push，没有修改原生队列数据。
