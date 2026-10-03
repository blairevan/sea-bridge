# Telegram 自动选择来源部署记录

- 日期：2026-10-03
- 用户授权：本轮明确要求“部署”。
- 版本：v0.5.3，包含 v0.5.1、v0.5.2 尚未上线的修复及本轮 Telegram 自动路由。
- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.5.3-20261003-083128`。
- 服务：`com.aitools.sea-bridge`，LaunchAgent running，新 PID 50203。

## 行为

直接输入按当前 Telegram 聊天最新关联消息 ID，自动选择 dsh 或 Codex 会话；显式回复继续原消息对应会话。只读 dsh 和映射冲突阻止投递，不回退到其他来源。跨聊天隔离、历史补写排序与重复 update 已覆盖回归。

## 发布与回滚准备

发布目录只包含构建产物、package.json 和启动脚本，启动脚本运行 `dist/main.js`。沿用原环境文件、数据库、设备认证、dsh connector 和网络入口。

旧 v0.5.0 发布目录保留。发布目录的 `rollback/` 保存原 LaunchAgent plist 和 SQLite 在线一致性备份；备份 `PRAGMA quick_check` 返回 ok，文件权限为 0600。数据库备份仅用于明确需要恢复数据的情况，普通回退优先切回原启动配置。

切换使用 Python plistlib 更新 ProgramArguments，并执行 `launchctl bootout gui/501/com.aitools.sea-bridge`、`launchctl bootstrap gui/501 /Users/example/Library/LaunchAgents/com.aitools.sea-bridge.plist`。首次 bootstrap 因旧服务尚未完成卸载返回错误 5；确认旧服务及监听退出后，重新 bootstrap 新配置成功。

## 验证

- `bun run typecheck`：通过。
- `bun test`：296 pass / 0 fail。
- `bun run build`：通过。
- `git diff --check`：通过。项目没有配置 lint/format 命令。
- `launchctl print gui/501/com.aitools.sea-bridge`：running，启动脚本指向 v0.5.3。
- `lsof -nP -iTCP:7310 -sTCP:LISTEN`：新进程仅监听 127.0.0.1:7310。
- Python urllib 请求本机与当前配置的远程入口 `/`、`/app.js?v=0.5.3`、`/app.css?v=0.5.3`：全部 200，响应字节与发布目录一致。
- 本机未认证 `/api/status`：401。
- 新进程日志：`dsh_connected`，connector 0.4.0，notificationsEnabled/writeEnabled 均 true；`telegram_polling_healthy` 证明成功完成接收轮询。
- 发布的 main.js/server.js 与本轮已验证构建逐字节一致。

部署检查没有发送测试 Telegram 消息或向真实会话写入测试提示词；实际手机直接输入的端到端投递仍需真实使用确认。本轮没有 commit/push。
