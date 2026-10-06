# v1.1.1：自动恢复阈值 30 秒部署

- 用户授权部署、提交、push 和 merge。
- 发布：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v1.1.1-20261006-202712`。
- 备份：`~/.config/sea-bridge/backups/20261006-202712/`；保留 v1.1.0 发布及原 plist、SQLite 一致性备份。
- 新 PID：93678；LaunchAgent running，仅监听 `127.0.0.1:7310`。
- 启动日志 `codex_queue_recovery_started.queueWaitMs` 为 **30000**，已确认运行中服务使用新阈值。
- 本机与公网首页 v1.1.1 / HTTP 200，设置说明为 30 秒；JS/CSS 与发布文件逐字节一致，未认证 session 均为 401。
- 数据库 quick_check 为 ok，管理员记录和 6 个设备凭据/撤销状态保留。新启动日志没有 error 事件。

## 修改与验证

恢复候选筛选、打开前队列复核和启动日志共用 `QUEUE_WAIT_MS = 30_000`。设置说明、顶部消息与 README 同步。回归覆盖 10 秒后、29.999 秒、30 秒均不触发，30.001 秒才触发；其他审批、去重、冷却和失败处理沿用。

```bash
bun run typecheck
node --check src/web/public/app.js
git diff --check
bun test
bun run build
launchctl bootout "gui/$(id -u)/com.aitools.sea-bridge"
plutil -lint "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
lsof -nP -iTCP:7310 -sTCP:LISTEN
```

428 pass、0 fail、1902 expect、66 files；构建和静态检查通过。公网通过实际部署域名使用 `curl -sS --max-time 20 -A 'Mozilla/5.0'` 验证首页、版本资源和未认证 `/api/auth/session`。发布产物与构建一致。

## 边界

本轮没有投递真实测试任务验证 30 秒实际激活时刻，阈值行为依据单元测试与生产启动日志确认。真实 iPhone 提示和长时间运行未本轮观察。未修改账号、原生 Codex 队列或 observer 状态，无新增依赖。
