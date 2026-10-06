# v1.1.0 自动恢复部署验收

## 发布结果

- 用户通过 Telegram 明确授权部署。
- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v1.1.0-20261006-122856`。
- 备份：`~/.config/sea-bridge/backups/20261006-122856/`，包含旧 plist 和 SQLite 一致性备份，旧发布目录保留。
- LaunchAgent `com.aitools.sea-bridge` 已重新加载，PID 37702；仅监听 `127.0.0.1:7310`。
- 版本由 1.0.2 更新为 1.1.0，资源缓存参数同步更新。
- 未提交或推送。未重设账号、清理设备、重置 observer 或修改 Codex 原生数据库。

## 功能和实时证据

- 服务端每秒监测原生队列，空闲且排队超过 10 秒时请求激活 Desktop。同批消息只尝试一次，手动入口在设置中保留。
- 自动恢复结果通过 SSE 进入当前会话顶部提示区，只描述激活请求结果。
- 新服务日志出现 `codex_queue_recovery_started`，随后实际出现 1 次 `codex_queue_recovery_requested` 和 `codex_queue_recovery_open_requested`。
- 同一会话随后出现 `codex_queue_item_left` 与 `codex_queue_execution_observed`，证明本次真实积压项被消费并出现执行证据。没有主动投递测试任务。
- 新日志没有 error 事件；已有长等待告警仍按原有诊断逻辑记录。

## 验证

执行命令：

```bash
bun run typecheck
node --check src/web/public/app.js
git diff --check
bun test
bun run build
launchctl bootout "gui/$(id -u)/com.aitools.sea-bridge"
plutil -lint "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl print "gui/$(id -u)/com.aitools.sea-bridge"
lsof -nP -iTCP:7310 -sTCP:LISTEN
```

- 全量测试：428 pass，0 fail，1899 expect，66 files。
- 本机及公网首页 HTTP 200、v1.1.0；JS/CSS 与发布文件逐字节匹配，版本资源带 immutable 缓存。
- 公网使用实际运行域名通过 `curl -sS --max-time 20 -A 'Mozilla/5.0'` 核验首页、`/app.js?v=1.1.0`、`/app.css?v=1.1.0` 和 `/api/auth/session`。默认 Python urllib 请求首次返回 403，浏览器请求标识的 curl 全部通过；没有修改代理或访问策略。
- 本机和公网未认证 `/api/auth/session` 均返回 401。
- 发布文件 `main.js`、HTML、JS、CSS 与构建产物一致。
- SQLite `PRAGMA quick_check` 为 ok；备份与运行库管理员记录一致，6 个设备的登录凭据及撤销状态保留。

## 验收边界

本轮核实了真实自动激活和后续队列执行证据。顶部提示已通过服务端 SSE 和浏览器逻辑回归测试，未本轮在真实 iPhone 页面观察；离线/后台期间的恢复事件不补发。页面刷新后读取 v1.1.0 资源。
