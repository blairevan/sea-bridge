# Codex 创建来源实施计划

依据：2026-10-04-codex-client-provenance-design.md。用户已批准继续实施，当前 feature/web-console。只实施并验证，不提交或部署。

架构：desktop 层分类原始元数据；Web 只传递归一化 creationClient；平台身份保持 codex/dsh。

- [x] 1. 纠正之前四个错误显示补丁，采集目标 Mac 脱敏 fixture；确认 schema 和版本。
- [x] 2. 增加纯函数分类及测试，固定四种 SQL profile、一次 schema 变化重试；验证不泄漏原值。
- [x] 3. 扩展 WebSession 与会话来源筛选；测试分页前过滤、未知、非法参数、dsh 边界。
- [x] 4. 统一平台/创建来源显示，新增筛选及 paused 同语义缓存过滤；刚创建状态仅在浏览器展示。
- [x] 5. 回归测试、类型检查、语法检查、构建、diff 检查与自审；记录未完成的真实设备验收。

关键文件：src/desktop/codex-provenance.ts、codex-thread-store.ts；src/web/sources/types.ts、codex.ts、http.ts；src/web/public/app.js、index.html；tests/。

验证命令：bun run typecheck；bun test；node --check src/web/public/app.js；bun run build；git diff --check。项目无独立 lint/format 脚本，不新增依赖。


## 验证结果与边界

2026-10-04：代码审查后补充 schema 热变化、无关 dsh 故障隔离、paused 跨筛选缓存和直接导航筛选清理修复；类型检查、全量测试 361 pass / 0 fail（1695 expectations / 60 files）、JS 语法检查、构建、git diff --check 通过。目标 Mac fixture 已采集，Codex CLI 0.160.0；普通会话只读投影验证 547 条，未将原始 source/originator 暴露到 Web 模型。

实施完成时尚未提交、推送或部署；已登录真实页面及 iPhone 验收留待部署阶段。重新部署前应确认目标版本/schema 未变化，变化则重新采集 fixture 并核对分类白名单。

部署补记：用户授权后已发布 v0.14.2，运行资源验证通过；用户随后授权提交与推送，本记录随功能提交；真实登录与手机验收仍待完成。
