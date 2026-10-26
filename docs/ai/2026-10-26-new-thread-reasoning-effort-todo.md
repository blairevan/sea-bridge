# Sea-Bridge 新建会话支持模型推理强度选择

- 需求来源：https://my.feishu.cn/docx/BKvMd9uGRo8qVdxIwyEcbG64nvd (Block ID: IzoJdqnlEopk0uxTgR3cUnk3nnf)
- 任务标识：new-thread-reasoning-effort
- 项目 / 仓库 / Worktree：/opt/app/aitools/sea-bridge
- 执行模式：待确认（标准模式 / 一镜到底模式）
- 授权记录：已选择文档 5「sea-bridge需求与记录」第 5 条「新建会话Tab 页」；用户确认方案选择「方式一（对齐 Desktop 默认视野）」；分支与执行模式待确认
- 分支 / 基线：main (commit 77e2243)
- 状态：in_progress

| 阶段 | 状态 | 证据 | 未完成原因 / 下一步 |
| --- | --- | --- | --- |
| 1 | DONE | profile personal + 文档 5 大纲读取成功，用户选择第 5 条 | |
| 2 | DONE | Block ID IzoJdqnlEopk0uxTgR3cUnk3nnf + 正文「缺少模型的推理强度选择」+ 物理 Todo 落盘 | |
| 3 | DONE | 调用原生 set_thread_title 将会话标题规范化为「新建会话Tab页支持模型推理强度选择」 | |
| 4 | DONE | 排查 src/web/public/{index.html,app.js}、src/web/{http.ts,operations.ts,sources/types.ts,sources/codex.ts}、src/desktop/{codex-app-server-client.ts,codex-read-service.ts}；cass 工具未安装（已记录工具不可用） | |
| 5 | DONE | 根因与方案分析完成，提供三节结构（目标与证据、方案、风险与验证） | |
| 6 | DONE | 方案选定「方式一（对齐 Desktop 默认视野：默认、低、中、高）」；brainstorming 未选用 | 待确认执行模式 |
| 7 | DONE | 归档 docs/ai/2026-10-26-new-thread-reasoning-effort-{design,plan}.md | |
| 8 | PENDING | 计划创建隔离分支 codex/new-thread-reasoning-effort | 待用户确认分支与隔离策略 |
| 9 | PENDING | TDD 实现与分层质量检查 | |
| 10 | PENDING | AGENTS.md 符合性复核 | |
| 11 | PENDING | 独立审查 | |
| 12 | PENDING | Git 提交与发布（待显式授权） | |
| 13 | PENDING | 飞书增量回写与完成标记（待显式授权） | |
| 14 | PENDING | 复盘、安全清理与交付 | |

## 阶段清单

- [x] 1 文档与身份解析
- [x] 2 目标提取、截图检查与物理 Todo
- [x] 3 会话标题规范化
- [x] 4 真实代码排查与历史召回
- [x] 5 根因与方案分析
- [x] 6 方案、模式及 brainstorming 决策
- [x] 7 Spec / Plan 归档
- [ ] 8 分支与工作区隔离
- [ ] 9 TDD、精准改造及分层质量检查
- [ ] 10 AGENTS.md 符合性复核
- [ ] 11 独立审查与最终候选树 PASS
- [ ] 12 Git 提交 / Push / PR / 合并及状态核验
- [ ] 13 飞书增量回写、核验与完成标记
- [ ] 14 复盘、安全清理与最终交付

