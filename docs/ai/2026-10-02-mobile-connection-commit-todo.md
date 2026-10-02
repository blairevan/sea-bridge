# 手机布局与断线恢复提交清单

- 分支 feature/web-console，用户明确授权提交和 push。作者/提交者与上一提交一致，无冲突、无预先暂存内容。
1. [x] 改动范围/敏感信息/依赖核验。无依赖变更，截图为合成消息。
2. [x] 内置只读语义审查与回归：修复正文超时和过期恢复结果；移除测试 any。
3. [x] bun run typecheck；bun test（243 pass）；bun run build；git diff --check。无 lint/format 脚本。
4. [x] 精确暂存、Conventional Commit。
5. [x] Push 并核对远端与本地。

拟提交：fix(web-console): improve mobile reading and connection recovery

代码提交 047468d 已 push origin/feature/web-console，流程完成。
