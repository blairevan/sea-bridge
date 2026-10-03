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

## v0.6.2 状态栏修正

“queued”是持久化的投递结果；普通queue投递尚未持久化client_id到turn_id的网页操作关联，因此会话执行证据常为exact=false。状态栏改为“会话正在执行”，精确关联保持“正在执行”，避免把历史入队回执当实时排队状态；原生队列气泡仍表示真实待处理消息。本次没有新增精确关联实现，也不能借此声称已证明具体输入执行。

测试先将会话级显示期望改为新文案并复现失败，再修改实现通过。`bun run typecheck`、`bun test`（310/0）、`bun run build`、`git diff --check`通过。发布目录：/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.6.2-20261003-175033；本机及Tailscale入口首页/JS/CSS全部200且匹配发布字节，未认证API401。部署保留旧发布、plist及0600数据库一致性备份。

## v0.6.3 输入区状态归属修正

用户指出：输入已清空，旧消息的投递及执行状态却一直留在输入框下方。修正为正常发送后清空并隐藏输入区状态；排队保留在原生消息气泡；来源运行及审批状态仍通过会话标题显示。输入区仅在发送中、失败或结果待确认时显示提示和核查入口。新最终回复只短暂通知，且不会清除另一个待核查操作的提示。旧操作轮询不覆盖另一条正在发送的状态。

测试先修改显示期望复现两项失败，再修复通过。新增正常queued/accepted、失败、未知结果和连续提交保护测试。`bun run typecheck`、`bun test`（311/0）、`bun run build`、`git diff --check`和`node --check src/web/public/app.js`通过。发布目录：/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.6.3-20261003-175407。本机及Tailscale首页/JS/CSS全部200且匹配发布字节，未认证API401；旧发布、plist及0600一致性数据库备份保留。未声称具体输入与执行turn已精确关联。

## v0.6.4 原生状态与等待时长

当前历史接口附带sessionState，原生task_started/complete/aborted作为无Hook时的执行中/空闲兜底；最近读取缓存10秒、上限100项供列表使用，不在发现接口扫描全部rollout。分页读取旧历史时也独立读取最新任务状态。队列标记超过两分钟显示已等待分钟数；未知读取不显示确切排队时长。

`bun run typecheck`、`bun test`（313/0）、`bun run build`、`git diff --check`通过。追加UI标题状态断言的聚焦测试27/0。当前真实业务会话通过只读source.history检查返回running、该次原生queueCount=2（快照只表示当时仍有待处理输入），无消息内容输出或业务投递。发布：/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.6.4-20261003-183524。本机和Tailscale首页/JS/CSS全部200且字节匹配发布；原plist及0600一致性SQLite备份保留。

没有启用生产自动resume：Desktop后端没有可连接控制socket。隔离实验机制结果与脱敏故障报告分别见[诊断时间线](2026-10-03-codex-queue-diagnosis.md)和[上游报告草稿](codex-queue-upstream-report.md)。未对外发报告，未声称真实长等待根因已修复。

## v0.7.0 部署

2026-10-03 22:10部署 `/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.7.0-20261003-221034`。保留旧发布，备份LaunchAgent和SQLite（quick_check=ok），切换服务后核对PID13413及启动日志。loopback与Tailscale入口HTML均200，版本v0.7.0，JS/CSS与发布文件逐字节一致；未认证打开接口返回401。Telegram轮询启动并成功同步命令。仅重启Sea-Bridge，未重启或更改Desktop后端。

验证命令/方式：`bun run build`、`launchctl bootout gui/501/com.aitools.sea-bridge`、`launchctl bootstrap gui/501 ~/Library/LaunchAgents/com.aitools.sea-bridge.plist`、`launchctl print gui/501/com.aitools.sea-bridge`；Python urllib禁用环境代理访问两端并比较发布资源。外部深链真实触发与iPhone完整操作路径未验收，不宣称恢复功能端到端通过。
