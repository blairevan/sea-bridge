# Password Login Implementation Plan

**Goal:** 将配对码替换为单管理员账号密码登录。

**Architecture:** 本机 CLI 生成 Argon2id 哈希，经私有控制 socket 更新 SQLite 管理员凭据。HTTP 异步验证凭据并沿用设备会话和 CSRF。

**Tech Stack:** Bun、TypeScript、SQLite、现有 node:net；无新增依赖。

**Spec:** docs/superpowers/specs/2026-10-04-password-login-design.md

## 约束

不生成真实密码，不打印凭据，不提交或推送；保留现有桥接数据。用户已批准在当前功能分支实施。

## 实施步骤

- [x] 先更新 tests/web-auth.test.ts：登录成功、通用失败、限流、修改密码与在途校验失效、旧会话迁移；运行 `bun test tests/web-auth.test.ts` 验证失败。
- [x] 修改 src/web/migrations.ts、store.ts、auth.ts：管理员凭据表和修订号、原子撤销会话、异步 Argon2id 校验与有界限流。
- [x] 修改 src/web/http.ts、control-server.ts、runtime.ts 和 scripts/web-control.ts：login API、本机账号设置、流关闭和隐藏输入。
- [x] 修改 src/web/public/index.html、app.js、app.css：账号密码表单和登录文案；更新 HTTP、控制 socket、SSE、UI 回归。
- [x] 更新 package.json 版本与命令及 docs/ai 操作指引；运行 `bun run typecheck`、`node --check src/web/public/app.js`、`bun test`、`bun run build`、`git diff --check`。项目没有 lint/format 脚本，保留现有格式。
- [x] 启动隔离 Web 实例验证真实 HTTP 登录、重置及 Cookie，不向运行中的旧服务设置测试账号；记录部署和首次账号设置边界。

完成记录：340 项测试通过，v0.13.0 已切换并验证。详情见 docs/ai/2026-10-04-password-login.md。
