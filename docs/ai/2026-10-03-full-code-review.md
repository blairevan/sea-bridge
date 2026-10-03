# Sea-Bridge 全面代码审查与修复 — 2026-10-03

## 范围与状态

- 基线：`feature/web-console`，`ddf238083dc3f9055811c63c753af4766c0c0384`，v0.5.1；开始时工作区干净。
- 审查范围：Web HTTP/认证/脱敏/SSE/分页、浏览器异步交互、Codex/dsh 适配、Telegram 创建、通知与关闭生命周期。
- 独立审查员分别检查前端、Web 服务端、来源适配；主任务逐项复现、修复并补回归，修复后再次定向复核。
- 18 项确定缺陷已修复，版本为 **v0.5.2**。审查阶段未 commit、push、重启或部署；随后用户明确授权提交并 push，本次交付不包含部署。未修改 Tailscale Serve/Funnel 配置。
- 基线 264 tests passed；修复后 **289 passed / 0 failed，1286 expect()，49 个测试文件**。

## 已修复问题

| 编号 | 缺陷与触发条件 | 修复 | 回归依据 |
| --- | --- | --- | --- |
| 1 | 新建会话成功后仍保留旧会话消息与分页游标，首次历史刷新混入旧内容 | 新建成功时重置消息、游标、节点缓存；等待回复基线不复用旧会话 | `web-ui-races` 的新建会话场景 |
| 2 | 多个 GET 交错时，已完成的旧脱敏策略结果可在清理后重新渲染；目录也存在同类缺口 | 增加 display epoch，概览、目录、历史、记录、设备、创建目录与操作展示在 await 后复核；响应版本变化走策略恢复 | `web-ui-races` 的概览、目录微任务交错 |
| 3 | 重新配对后，上一身份的在途请求可被新身份采用；旧读取清理还可能删除新请求缓存，旧 action 忙锁阻塞新操作 | auth epoch、认证边界清理原操作状态、条件删除读取 promise、按认证/显示代次隔离忙锁 | `web-ui-races` 的旧请求、缓存、忙锁场景 |
| 4 | 连续设置事件遇到同名 settings-sync 忙锁时，第二次同步丢失，页面一直暂停且没有重试 | 设置失效统一关闭旧流并调度恢复；新流使用独立恢复键，旧恢复不能影响当前尝试 | 连续设置事件及新 SSE 验证到 version=2 的完整回归 |
| 5 | 创建目录加载中切换来源，第二次 catalog 操作被忙锁吞掉，最终来源表单一直禁用 | 来源变更按来源区分忙锁，并保留异步来源/epoch 校验 | 实际 onchange 绑定回归 |
| 6 | 写请求只在读取 body 前认证，上传过程中撤销/到期后仍能修改设置或派发 | body 读取完成后重新检查 session 和 CSRF，再进入持久化/派发 | `web-http` 流式上传中撤销，设置与来源写入都返回 401 |
| 7 | SSE 心跳绕过事件缓冲上限，慢客户端不读时持续积压 | 控制事件和心跳共享有界 enqueue | `web-sse` 100 次心跳，不超过 18 个缓冲块 |
| 8 | 本机 pairing socket stop 等待未结束连接；持续发送小块可绕过 idle timeout | 跟踪/关闭存量 socket，并增加与活动无关的 2 秒绝对期限 | `web-control-server` 未完成客户端下关闭测试 |
| 9 | Telegram provider SQL 数字排序与合并后的字符串排序不一致，同时间戳分页重复/漏项 | SQL 与合并统一按二进制字符串 ID 排序，前端窗口边界使用相同规则 | `web-records` 三来源 120 条同时间戳记录，多页完整且唯一 |
| 10 | 真实 dsh 客户端拒绝合法空历史 cursor=-1 | 解析最小值调整为 -1 | `dsh-web-host-client` 真实 socket 合同回归 |
| 11 | dsh 积压超过 256 条时整个恢复区间被拒绝；只切为 256 条仍可能超过 32 页上限 | 每批最多 32 个事件，逐批持久化游标；有剩余积压立即安排下一轮 | `dsh-session-observer` 513 条积压及每页一条事件回归 |
| 12 | accepted Web prompt 查询按最早 100 条截断，后续发送永远不进入 dsh 历史 | 先取最新 100 条，再按展示顺序返回 | `web-store` 105 条记录保留第 6 至 105 条 |
| 13 | dsh Host 尚未产生事件时，已 accepted 的 Web prompt 被空历史分支丢弃 | cursor=-1 的最新页也合并已接受本地快照 | `web-dsh-source` 空 Host 历史仍返回 accepted prompt |
| 14 | Telegram `/new` 启动成功后映射保存失败，或处理完成前崩溃，重试会新建第二个会话 | 新增 `codex_creation_requests`；派发前持久化 claim，thread/start 后立即保存已知 ID，启动后保存 turn；映射失败不重放，模糊结果不自动创建 | `telegram-project-new-thread` 映射失败、磁盘重启、callback/全部状态更新失败注入 |
| 15 | DesktopObserver.stop 只停定时器，不等待通知发送/落库；关库后可能丢映射并重复通知 | 跟踪并等待 active poll | `desktop-observer` 阻塞发送时 stop 不提前结束 |
| 16 | Telegram.stop 不等待已派发 update，关库后无法保存处理结果 | 停止新 update 接纳，等待 active update；主生命周期 await stop | `telegram-project-new-thread` 阻塞 acknowledgement 时 stop 等待并保留 processed |
| 17 | Bun stop(true) 关闭连接后，fetch handler 仍可能运行并在关库后持久化 | WebServer 跟踪并等待已接纳处理器，停止新接纳 | `web-static` 真正 loopback HTTP 阻塞 handler 关闭测试 |
| 18 | 等待处理器收尾时，Codex queue 子进程没有期限，卡住会阻塞整个 shutdown | queue CLI 最多等 15 秒，超时 SIGKILL 后等待 exit，返回 `delivery_unknown/codex_queue_timeout` | `codex-queue-client` 真实临时 executable 超时退出测试 |

## 设计边界

- 普通断线仍保留已加载的概览、会话、记录、目录和草稿；仅认证或脱敏策略失效时清理服务端内容。
- 不自动重发模糊投递，不将队列接收推断为实际开始执行。
- 撤销复核阻止尚未派发的上传请求；已经启动的来源任务不被伪装成已取消。
- 创建 claim 只保存 update ID、状态、thread/turn ID 与时间，不保存 prompt 或凭据。崩溃后不确定的请求需要核查，不能通过重试偷偷新建第二个会话。
- 无新依赖，无类型绕过，无无关重构。已有大文件未在本轮拆分，后续模块化应独立进行并保持交互回归。

## 验证

项目没有 lint/format 脚本；实际执行：

```bash
bun test
bun run typecheck
bun run build
git diff --check
```

全部通过。用 VM 明确控制浏览器请求/事件完成顺序；用 SQLite 故障注入、磁盘重启、真实本机 socket/HTTP 和临时 CLI 验证边界。修复前对应关键回归先失败，修复后通过；停止新 update 接纳后同步调整原 receive/handler 分类测试，让停止发生在处理失败后。

只读读取 `http://127.0.0.1:7310/` 的 HTML 确认运行版本仍为 **v0.5.0**；构建产物为 v0.5.2。未做真实 Codex/dsh/Telegram 写入、iPhone/Shadowrocket 验收，本轮自动检查不能替代部署后的设备验证。
