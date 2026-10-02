# Web console 提交清单

- 仓库：/opt/app/aitools/sea-bridge
- 分支：feature/web-console
- 范围：本轮 Web 安全与来源失败状态修复、Tailnet IP 支持、Markdown/图片/时间与移动端历史、测试及验收文档。
- 用户已明确授权提交和 push。

1. [x] 核验项目规则、feature 分支、无冲突、作者一致及 origin。
2. [x] 检查依赖与敏感信息，截图为无凭据验收样例。
3. [x] 质量检查：bun run typecheck；bun test（236 pass）；bun run build；git diff --check。项目无 lint/format 脚本，未新增工具依赖。
4. [x] 只读代码审查及发现项复核：Cursor CLI 未返回结果，终止后按 skill 保底执行内置语义审查；HTTP logout Secure 修复已通过回归。
5. [ ] 精确暂存、核对文件清单、Conventional Commit。
6. [ ] Push feature/web-console 并核对远端提交与本地工作区。

拟提交：fix(web-console): harden dispatch and mobile message history

审查结论：未发现阻断项。保持既有有界历史读取和来源历史限制；真实 iPhone 滚动验收不能由 fixture 替代。
