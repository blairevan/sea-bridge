# Codex 排队消息展示与部署

- 用户授权：修改代码，然后部署。
- 版本：v0.6.0。
- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.6.0-20261003-084556`。
- LaunchAgent：`com.aitools.sea-bridge`，running，新 PID 68221。

## 实现与数据依据

本机 Codex 原生 `~/.codex/queue_1.sqlite` 的 `queued_items` 表包含 id、thread_id、payload_json、queue_order、created_at_ms、updated_at_ms。实际排队文本使用 `UserInput.content[].type=text/text` 结构。

新增 `src/desktop/codex-queue-store.ts`，只读访问可信服务端路径，不创建、迁移或修改 Codex 队列数据库。按 thread_id 隔离，以 queue_order/id 排序，只解析支持的用户文本；缺失、损坏或不兼容队列返回不可用，不假装为空。

Codex history 响应将已执行 messages 与当前 queuedMessages 分开返回，沿用认证及脱敏流程。网页将当前队列显示在对话底部：右侧圆角用户气泡，上方“↳ 排队中”。刷新替换队列快照，保留既有历史分页；编辑按原队列 ID 更新，消费或取消后移除排队气泡。读取失败保留已显示队列并标注“排队状态待确认”。队列移出不等于本轮已开始，正常消息展示仍依据 rollout 历史。

本轮也修正操作状态栏：只有确切 turn 执行证据才显示“正在执行”；queued 操作收到会话级运行证据时提示本条是否开始尚未确认。队列展示只读，编辑和取消仍通过 Codex 原入口进行。仅支持原生队列中可解析的文本输入，本轮不实现附件预览。

## 验证

- `bun run typecheck`：通过。
- `bun test`：302 pass / 0 fail。
- `bun test tests/codex-queue-store.test.ts tests/web-codex-source.test.ts tests/web-message-ui.test.ts`：35 pass / 0 fail。
- `bun run build`、`git diff --check`：通过；无配置的 lint/format 命令。
- 首轮新来源/UI 测试先复现失败，再验证修复通过；状态栏回归也先失败再通过。
- 使用已有 Playwright/Chrome，通过 `/tmp/sea-bridge-queue-visual.cjs` 运行生产渲染函数与 CSS，验证 320、390、1024 宽度无横向溢出、气泡右对齐、标记正确及队列消费后移除。没有安装新依赖。
- [手机宽度预览](2026-10-03-queued-messages-mobile.png) 使用安全模拟消息，非真实会话截屏。
- 本机真实原生队列只读检查：available=true，1 个 thread / 1 条排队文本，没有输出或修改实际消息内容。

## 发布与运行验收

保留旧 v0.5.3 发布目录，新发布目录 rollback/ 保存原 plist 和 SQLite 一致性备份（0600，quick_check=ok）。新快照运行构建后的 dist/main.js，沿用现有环境文件、数据库、设备认证与网络入口。

使用 `launchctl bootout gui/501/com.aitools.sea-bridge`，等待旧服务完成卸载后执行 `launchctl bootstrap gui/501 /Users/example/Library/LaunchAgents/com.aitools.sea-bridge.plist` 切换。

- `launchctl print gui/501/com.aitools.sea-bridge`：running，启动脚本指向 v0.6.0。
- `lsof -nP -iTCP:7310 -sTCP:LISTEN`：68221，仅监听 127.0.0.1:7310。
- Python urllib 检查本机及当前远程入口 `/`、`/app.js?v=0.6.0`、`/app.css?v=0.6.0`：全部 200，响应字节与发布资源一致。
- 未认证 `/api/status` 为 401；新进程日志确认 `dsh_connected` 与 `telegram_polling_healthy`。
- 发布 main.js 与已验证工作区构建一致。

本轮没有发送真实测试提示词，也没有更改 Codex 队列数据；手机 Safari 的真实排队到执行全过程需实际使用确认。没有 commit/push。
