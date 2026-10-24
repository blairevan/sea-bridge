# Sea-Bridge 独立 URL 路由支持

- 需求来源：https://my.feishu.cn/docx/BKvMd9uGRo8qVdxIwyEcbG64nvd (Block ID: XlPhdMWuFoTI28xOjF7c3bmCnJb)
- 任务标识：independent-url-routes
- 项目 / 仓库 / Worktree：/opt/app/aitools/sea-bridge
- 执行模式：standard
- 授权记录：用户授权一镜到底模式，确认方案 1；自动推进工程交付
- 分支 / 基线：codex/independent-url-routes (commit 780dc48)
- 状态：in_progress

| 阶段 | 状态 | 证据 | 未完成原因 / 下一步 |
| --- | --- | --- | --- |
| 1 | DONE | profile personal + 文档 5 大纲读取成功 | |
| 2 | DONE | Block ID XlPhdMWuFoTI28xOjF7c3bmCnJb + 落盘物理 Todo | |
| 3 | DONE | tools.mcp__codex_app__set_thread_title 修改为「Sea-Bridge 独立 URL 路由支持」 | |
| 4 | DONE | 明确 server.ts 路由白名单、app.js 路由联动及 localStorage 存储区间 | |
| 5 | DONE | 根因与方案设计完成 | |
| 6 | DONE | 方案 1 确认，授权一镜到底 | |
| 7 | DONE | docs/ai/2026-10-24-independent-url-routes-{design,plan}.md 归档完成 | |
| 8 | DONE | 创建并切换到 codex/independent-url-routes 分支 | |
| 9 | IN_PROGRESS | TDD 编写测试与代码精准改造 | |
| 10 | PENDING | 规约复核 | |
| 11 | PENDING | 独立审查 | |
| 12 | PENDING | Git 提交与发布 | |
| 13 | PENDING | 飞书增量回写 | |
| 14 | PENDING | 复盘与安全清理 | |

## 阶段清单

- [x] 1 文档与身份解析
- [x] 2 目标提取、截图检查与物理 Todo
- [x] 3 会话标题规范化
- [x] 4 真实代码排查与历史召回
- [x] 5 根因与方案分析
- [x] 6 方案、模式及 brainstorming 决策
- [x] 7 Spec / Plan 归档
- [x] 8 分支与工作区隔离
- [ ] 9 TDD、精准改造及分层质量检查
- [ ] 10 AGENTS.md 符合性复核
- [ ] 11 独立审查与最终候选树 PASS
- [ ] 12 Git 提交 / Push / PR / 合并及状态核验
- [ ] 13 飞书增量回写、核验与完成标记
- [ ] 14 复盘与安全清理与最终交付
