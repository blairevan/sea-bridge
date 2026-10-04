# 账号密码登录

## 使用

v0.13.0 将配对码登录替换为单管理员账号密码登录。升级会撤销所有旧配对会话。

在 Mac 本机终端执行：

```bash
cd /opt/app/aitools/sea-bridge
bun run web:account
```

按提示设置账号和密码，密码隐藏输入，需再次确认。账号为 3–64 位字母、数字、下划线、点或连字符，首位为字母或数字；密码为 12–256 个字符。命令不接受密码参数或重定向输入，无默认密码。

命令要求新版 Web 服务正在运行。若使用自定义控制 socket，执行前设置 `SEA_BRIDGE_WEB_CONTROL_SOCKET` 为服务实际路径。账号尚未设置时，网页登录始终失败。

重置密码使用同一命令，会立即撤销所有设备会话并关闭实时连接。设备登录会话保留 30 天，支持退出及逐设备撤销。密码不保存到浏览器存储或日志，SQLite 仅保存 Argon2id 哈希。

## Cloudflare 接入

将固定子域名 Tunnel 目标设置为 `http://127.0.0.1:7310`，服务配置 `SEA_BRIDGE_WEB_REMOTE_ORIGIN=https://实际子域名` 并重启。必须保留浏览器请求的 Host/Origin 与配置一致；无需额外开放本机端口。

远程账号密码登录仅允许 HTTPS，旧 Tailnet HTTP 地址无法提交密码；Mac 本机 loopback HTTP 仍可用。Cloudflare Access 可按需作为额外的邮箱认证层，应用账号密码始终保留。

## 实施记录

- 无新增依赖，未生成真实账号密码，未 commit/push。
- 每来源每分钟最多 5 次、全局最多 30 次登录尝试；最多 2 个并发密码校验。远程来源使用统一计数，不信任转发 IP 或身份头。
- 密码设置、凭据修订号更新及会话撤销在同一事务；在途旧凭据校验不能产生新会话。
- 迁移只撤销旧 Web 会话，不删除历史操作、日志或桥接业务数据。

## 验证与部署结果

- `bun run typecheck`：通过。
- `node --check src/web/public/app.js`：通过。
- `bun test`：340 pass / 0 fail，涵盖真实终端隐藏输入、密码确认、真实 HTTP 登录/退出/重置、旧配对接口禁用、旧会话迁移幂等和 CSRF。
- `bun run build`：通过。
- `git diff --check`：通过。无 lint/format 脚本。
- 发布目录：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.13.0-20261004-151552`，原启动配置、数据库一致性备份保存于该目录的 `rollback/`，备份和运行数据库 `PRAGMA quick_check` 均为 ok。
- LaunchAgent `com.aitools.sea-bridge` 已切换，新 PID 87532，仅监听 `127.0.0.1:7310`。此前的 v0.12.0 发布目录保留。
- Python urllib 实际请求：`/`、`/app.js?v=0.13.0`、`/app.css?v=0.13.0` 均 200；页面显示 v0.13.0、新登录字段，JS/CSS 与发布文件逐字节一致。
- `/api/auth/session` 未登录返回 401；`/api/auth/pair` 返回 404；管理员表为空，旧 Web 会话全部撤销，桥接业务表行数未减少。
- 内置语义复核完成：检查 Host/Origin、转发头限流绕过、异步密码校验并发、重置修订号、Cookie/CSRF、密码持久化及日志边界。发现终端提示先于关闭回显的竞态，已修正并由真实 PTY 测试覆盖；远程 HTTP 页面在发送前拒绝密码并清空字段。

## 代码审查补丁

部署后复审发现并修复两项前端边界问题：登录表单显式使用 `POST /api/auth/login`，避免脚本异常或表单回退时浏览器按默认 GET 方式把账号密码带入 URL；启动超时提示移除旧 Tailscale 引导，改为检查 HTTPS 域名与 Tunnel。对应静态页面与启动提示测试已补充，全量 `bun test` 仍为 340 pass / 0 fail，`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 均通过。

上述两项属于部署后的工作区补丁，当前 7310 上已运行的 v0.13.0 发布目录尚未重新构建/切换，因此运行实例还不包含这两项补丁。

## 验收边界与回退

尚未设置真实账号，需用户在 Mac 终端运行 `bun run web:account`。未提供实际子域名，Cloudflare Tunnel/Access 尚未配置，iPhone 实机登录与域名端到端连接未验收。测试使用隔离实例和合成凭据，未向真实服务写入测试账号或向聊天发送测试内容。

普通回退切换到保留的旧发布目录即可；旧会话仍已撤销。数据库备份包含桥接业务数据，恢复会覆盖备份后的记录，需明确授权，不自动恢复。


## 复审补丁部署 v0.13.1

- 用户明确授权“部署代码”；2026-10-04 切换至 `/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.13.1-20261004-155051`。
- 版本递增到 v0.13.1，以新 JS/CSS URL 失效旧浏览器缓存。包含登录表单显式 POST 与 HTTPS/Tunnel 故障提示两项复审修复。
- `bun test`：340 pass / 0 fail；`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 均通过。无 lint/format 脚本。
- 已备份旧 LaunchAgent 配置和 SQLite，位于发布目录 `rollback/`；备份及运行库检查健康。
- LaunchAgent running，PID 28216；`lsof -nP -iTCP:7310 -sTCP:LISTEN` 确认仅监听 127.0.0.1:7310。
- Python urllib 实际检查：页面 200 且为 v0.13.1、表单含 method=post/action=/api/auth/login；版本 JS/CSS 200 且与发布文件逐字节一致，JS 包含 HTTPS 域名/Tunnel 新提示；未登录 session 401，旧配对接口 404。
- 与备份对比，管理员凭据、修订号及设备会话撤销状态完全保留。本次未重置账号，未 commit/push。
- 未对 Cloudflare 公网入口或 iPhone 实机做端到端验收；公网 remote 共享限流桶的可用性风险仍按复审建议处理，未在本次部署中改变认证策略。

## code.example.com 接入

- 用户授权配置 `code.example.com`，并明确选择“仅账号密码”，未启用 Cloudflare Access。
- 创建独立 Cloudflare Tunnel `sea-bridge-m5`，ID `00000000-0000-4000-8000-000000000000`；凭据保存在本机私有文件中，未写入仓库。现有 devspace 等隧道未改动。
- 配置 `/Users/example/.cloudflared/sea-bridge-m5.yml`：HTTP/2，`code.example.com` → `http://127.0.0.1:7310`，其他主机返回 404。
- 启动项 `/Users/example/Library/LaunchAgents/com.example.sea-bridge-cloudflared.plist`：RunAtLoad/KeepAlive，PID 34371，4 条边缘连接。使用现有 cloudflared 2026.8.2，未安装或升级依赖。
- 服务环境 `SEA_BRIDGE_WEB_REMOTE_ORIGIN=https://code.example.com`，原环境备份于 `/Users/example/.config/sea-bridge/cloudflare-backup-20261004-155432/env`（0600）。Sea-Bridge 重启后 PID 34369，仍只监听 127.0.0.1:7310。
- `cloudflared tunnel --config /Users/example/.cloudflared/sea-bridge-m5.yml ingress validate`：通过。
- `cloudflared tunnel --config /Users/example/.cloudflared/sea-bridge-m5.yml ingress rule https://code.example.com`：命中 7310 规则。
- `cloudflared tunnel --config /Users/example/.cloudflared/sea-bridge-m5.yml route dns 00000000-0000-4000-8000-000000000000 code.example.com`：新增 CNAME 成功，无覆盖已有记录。
- `cloudflared tunnel --config /Users/example/.cloudflared/sea-bridge-m5.yml info 00000000-0000-4000-8000-000000000000`：已连接。所有命令显式指定 config，防止默认 wecomdog 配置选择错误隧道。
- HTTPS GET 页面及版本 JS/CSS 全部 200，资源与 v0.13.1 构建逐字节一致；未登录 session 401，旧配对接口 404。带正确 Origin 的空登录请求 400，外国 Origin 请求 403。
- Codex 浏览器实际打开 `https://code.example.com/`，显示 v0.13.1 账号密码表单，JS 登录检查完成。
- Python urllib 默认客户端被现有 Cloudflare 边缘策略拒绝（1010）；curl 和真实浏览器正常。没有关闭或绕过 Cloudflare 安全策略。
- 管理员账号仍未设置，需用户本机执行 `bun run web:account`。未向真实服务写入测试凭据，未验收真实登录后的聊天操作、iPhone 蜂窝网络或长时间稳定性。
- 本次仅修改运行配置、DNS 与自动启动及文档，不改业务代码、不 commit/push。原 remote HTTP 地址不再在域名白名单内；本机地址仍可用。
