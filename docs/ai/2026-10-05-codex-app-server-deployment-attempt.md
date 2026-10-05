# Codex app-server 改造部署尝试与回滚

时间：2026-10-05 22:35，北京时间。

## 结果

新发布快照未通过真实运行验收，已停止并恢复原 LaunchAgent 配置。原服务已 running，本机首页返回 HTTP 200。

- 新快照：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.14.5-20261005-223514`。
- 已恢复快照：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.14.5-20261005-170509`。
- SQLite 一致性备份及旧 plist：`~/.config/sea-bridge/backups/20261005-223514/`。

未执行 observer reset，未修改 Codex 原生数据库/WAL，未回滚 Sea-Bridge 数据库，未 commit/push。

## 执行过程

1. 对照已验收 dist 与旧发布快照，确认运行服务仍为旧实现。
2. 创建新发布快照，保留配置和数据库位置。
3. 用 Python SQLite backup API 创建一致性备份，并执行 `PRAGMA quick_check`。
4. bootout 原应用，确认旧 PID 退出，切换 plist 后 bootstrap。
5. 验证新服务 HTTP 200；读取其本地状态库及日志。
6. 发现历史通知及 ReadService 缓冲失败，立即 bootout 新服务。
7. 恢复备份 plist 并 bootstrap 原应用，确认 running / HTTP 200。

## 真实运行发现

### 历史终态错误入队

新服务 baseline 期间向 Telegram 发送了历史会话终态通知。备份 outbox 共 392 条，停止新服务后为 414 条，新增 22 条均为 sent，pending 为 0。

这些通知已发送，无法通过数据库回滚撤回；保留当前数据库，保留通知及回复映射。

代码风险位置：`DesktopObserver.buildObservations()` 仅在 `completedAtMs` 非空且早于监控边界时 suppress。缺少 completedAt 的历史 terminal 会按新事件处理；初始 baseline 并未对这些历史 turn 应用独立的 suppression 规则。需结合官方返回的旧历史字段确认并修复，不能仅依靠 mock 的完整时间戳。

后续部署前必须覆盖：初始集合旧 terminal 的 completedAt 为 null、同一 baseline 内 running 后续 terminal、Sea-Bridge 新建 marker，以及已保留 outbox 的去重。

### stdout 缓冲上限导致重连

日志出现 `codex_read_service_transport_failed`，`errorCode=app_server_stdout_buffer_limit`，随后按退避重连。

当前 `AppServerSession.onData()` 在拆分换行前检查 buffer+chunk 是否超过 1 MiB。真实历史查询触发该上限；还需判定是单条有效响应过大还是一个 chunk 中包含多条消息。不能只无限扩大上限，应调整消息解析/分页与可配置资源边界，并用真实大历史验收。

## 修复进展（未重新部署）

本次失败暴露的两项问题已经在工作区修复并补充回归测试，但**尚未重新部署**：

1. 初始冻结集合首次 baseline 时，如果一个 terminal turn 此前没有 observation 且 `completedAt` 缺失，现在按历史快照 suppress；同一 turn 如果先观察到 running，之后再变 terminal，即使 `completedAt` 仍缺失也会正常通知；Sea-Bridge 自己创建的 thread marker 同样不会被 baseline suppression 吃掉。
2. app-server stdout framing 改为先按换行消费完整 JSON，再只对“未完成单行 buffer”执行上限检查，避免一个 chunk 内多条正常 JSON 因总长度超过 1 MiB 被误杀。单条 JSON 仍有明确上限，默认 8 MiB，可由 ReadService options 调整；ReadService 的 thread/turn/items 默认分页从 100 降为 25，进一步降低单次响应体积。
3. 已补覆盖：`completedAt=null` 的历史 terminal、running→terminal(null timestamp)、Sea-Bridge created marker、大于旧 1 MiB 的合法单条响应、多行聚合 chunk 超过 buffer 上限、真正未终止超限 buffer。

当前本地验证：`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 全部通过；`bun test` 为 **398 pass / 0 fail / 1814 expect()**。

## 后续要求

当前生产仍运行原发布，不能宣称 app-server 改造已部署成功。由于失败版本已经在当前 Sea-Bridge DB 写入新的 observer observation/anchor 状态，下次重试部署前应执行**同一 CODEX_HOME 的一次定向 observer reset**，清理本次失败版本留下的 catalog/observer 状态，同时保留现有 Telegram `desktop_message_links` 与 notification outbox。22 条已发送历史通知的 link/outbox 必须继续作为去重证据保留，不能恢复整个旧数据库备份，也不能直接沿用失败版本留下的 observer baseline 状态。

reset 后再启动新版本并重新 baseline；确认没有新增历史 terminal 通知、没有 `app_server_stdout_buffer_limit`/`app_server_message_size_limit`，再继续长时间运行验收。

## 验证命令

```bash
launchctl print "gui/$(id -u)/com.aitools.sea-bridge"
plutil -lint "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl bootout "gui/$(id -u)/com.aitools.sea-bridge"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7310/
```

数据库检查使用 mode=ro 查询目录、baseline 状态及 outbox 条数，不输出消息正文或账号凭据。

## 第二次发布：2026-10-05 22:51（北京时间）

两项修复验收后已重新部署成功，当前运行新读取实现。

- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.14.5-20261005-225152`。
- 停机后一致性备份：`~/.config/sea-bridge/backups/20261005-225152/`，包含旧 plist 与 `state.sqlite3`。
- 使用配置文件中的实际环境执行 `bun run codex:observer-reset`，结果 `environmentChanged=false`；未清理 links、outbox、pending prompts 或默认模型。
- 新快照的 main.js 与 Web app.js 和已验收构建逐字节一致。

### 部署前验证

`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`bun test`、`git diff --check` 全部通过。398 pass、0 fail、1814 expect()、65 files。

使用目标机真实 Codex CLI，在独立内存状态库运行新 observer，禁止真实 Telegram send：538 个会话全部 baseline 为 monitoring，outbox=0，deferred=0，ReadService generation=1。该实验覆盖真实大历史，未触发缓冲上限重连。

### 部署后验证

- LaunchAgent running，运行新快照；7310 仅监听 127.0.0.1。
- 本机与公网首页 HTTP 200；未登录本机 auth/session 为预期 401。
- 538 个会话全部 baseline 完成，bootstrap 完成时间已持久化，无 deferred/pending。
- 部署前后 links 均为 1348 条，outbox 均为 415 条；部署窗口无新增 outbox，未再次发送历史通知。
- 部署后 ReadService 只建立一次连接；未出现 baseline/observer/transport failure。
- 仍有部署前已有的两条 Codex queue 长等待告警，本次未操作这些积压消息。

Python urllib 请求公网曾返回 403；随后 curl 请求同一首页返回 200。公网验证以该次 curl 成功结果为准，不将单一客户端差异认定为服务故障。

### 验证边界

本次完成真实初始化、短期运行与访问验证。没有主动创建测试 Codex 任务、发送测试 Telegram 消息或执行故障注入；部署后的真实新 turn 通知、登录态手机交互与长时间稳定性仍需后续观察。未修改 Codex 原生数据库/WAL，未 commit/push。

## 首页主动能力采样发布：2026-10-05 23:13（北京时间）

- 已发布 v0.14.6，快照：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.14.6-20261005-231325`。
- 版本由 0.14.5 递增为 0.14.6，以更新手机静态资源缓存键。
- 备份：`~/.config/sea-bridge/backups/20261005-231325/`，包含一致性数据库和旧 plist。
- 未执行 observer reset；538 个 thread 仍为 monitoring，bootstrap 起点与备份一致。
- 发布前 typecheck、JS syntax、build、全量测试及 diff check 通过：402 pass、0 fail、1822 expect()、65 files。版本递增后重新 build。
- 使用真实 Codex CLI 和 dsh Host，在独立内存库构造新 Web sources 并调用 createStatusService：两者 sessions/projects/models/history 均采样为可读，createEnabled 为 true；没有调用创建或发送方法。
- 服务已 running；本机和公网首页均 HTTP 200。公网 HTML 显示 v0.14.6，并引用 `app.js?v=0.14.6`。
- 发布产物与验收 dist 一致；启动后 ReadService 连接一次，检查窗口未发现 failure 日志。
- 未在已登录手机中验证实际 UI，真实只读 source 采样验证与公网资源验证已完成。未 commit/push。

## 部署后真实 turn 的 interrupted 误判：2026-10-05 23:26–23:41（北京时间）

后续真实使用暴露新的通知正确性问题：独立 ReadService 对另一个进程仍在执行的 turn 会短暂投影 `interrupted`，该状态不能直接当作可靠终态。

现场两例：

- 23:26:16 启动的任务约 0.4 秒后被 Sea-Bridge 通知“已中断”，但 Codex 原始记录显示 23:26:54 正常完成；官方 API 之后返回 `completed` 且可读取 final reply。
- 23:39:30 启动的部署任务约 0.7 秒后被通知“已中断”，实际 23:41:23 正常完成；之后官方 API 同样返回 `completed` 和最终正文。

根因是 observer 把“无 `completedAt`、无 final reply 的 `interrupted`”立即写成不可变 terminal，并生成 Telegram outbox；后续真正 `completed` 被 terminal 冲突检查与 `(threadId,turnId)` 去重挡住。

工作区已修复但尚未重新部署：

1. 无 `completedAt`、无 `final_answer`、无同 turn 近期 exact `Interrupt` Hook 的 `interrupted` 只保存为 provisional pending：`terminal_kind=NULL`，不入 outbox，并持续 reconciliation；普通 settle deadline 不会把它自动升级成终态。
2. 官方 `interrupted` 带 `completedAt`、读到真正 final answer，或近期 Hook 对同 turn 明确观察到 `Interrupt` 时，仍可确认真实中断。
3. provisional interrupted 后变 `completed` 时正常升级并发送 completed/final reply。
4. 为已经被旧版本误发 interrupted 的 turn 增加窄范围 correction：只有既有 terminal identity 为 interrupted，且官方后来明确 completed 并具备 `completedAt` 或 final answer 完成证据时，允许一次 completed correction；使用独立 fingerprint。旧已发送 interrupted link 保留；若错误 interrupted 尚在 pending outbox，则事务内删除旧 pending 后再入队 correction。
5. `DesktopObserver` 接入近期 Hook runtime evidence，只有 exact same-turn `Interrupt` 用于确认无时间戳中断；缺少 Hook 不能反向证明中断。

新增回归覆盖真实时序、settle 超时仍不误判、completedAt 确认中断、exact Interrupt Hook、旧已发送 interrupted 的 completed correction，以及 pending interrupted outbox 的原子替换。

当前本地验证：`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 全部通过；`bun test` **409 pass / 0 fail / 1841 expect() / 65 files**。当前运行服务未因本轮修复重启或 reset；未重新部署、未 commit/push。

### 2026-10-06 v1.0.1 终态确认修复部署验收

- 原运行版本经 LaunchAgent 核实为 1.0.0，此次为 1.0.1。
- 审查补充未更正 interrupted 的分页追踪，403 后续新增测试现为 409 pass / 1843 expect。
- 一致性备份后停机换包，未 reset，未 schema 迁移。发布目录 `/opt/app/aitools/sea-bridge-releases/sea-bridge-v1.0.1-20261006-001007`。
- 正常冷轮询触发后，7 条 completed correction 均已 sent；旧 interrupted 的 7 条消息链接保留；新日志没有错误。
