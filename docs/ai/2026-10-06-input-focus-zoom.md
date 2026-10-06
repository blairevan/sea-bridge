# 输入控件聚焦放大修复 v1.0.2

1. [x] 用户授权修改、部署、提交、push 与合并；分支 `fix/mobile-input-zoom`，作者与上一提交一致，无冲突或无关修改。
2. [x] 新建会话首条消息继承 14px，统一 input/select/textarea 基础字号为 16px；不使用宽度或设备判断，不限制用户缩放。
3. [x] 静态回归测试先失败后通过；`bun test` 410 pass / 0 fail；`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 通过。项目无 lint/format 配置。
4. [x] 发布版本递增至 v1.0.2，避免 immutable 静态缓存；保留旧发布、启动配置和一致性数据库备份，备份 quick_check 为 ok。
5. [x] 新发布服务 running，仅监听 127.0.0.1:7310；本机与 HTTPS 首页使用 v1.0.2；CSS 哈希与构建一致；未登录 session 接口 401。
6. [x] Cursor 只读审查无 Critical；补充 user-scalable=0 护栏。基础 CSS 静态契约检查存在结构依赖，已明确其验证边界。
7. [ ] 提交、push、PR 合并及远程回读验收。

验证边界：静态测试检查基础样式契约，不等同浏览器计算样式或 iPhone 真机验收；手机聚焦体验仍需人工复测。未修改账号、Tunnel 或 Codex 状态，未重置数据库。
