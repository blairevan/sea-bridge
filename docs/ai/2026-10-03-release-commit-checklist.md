# v0.6.1 提交检查清单

分支：feature/web-console。范围：TG自动路由、排队展示、诊断日志及验收记录。用户明确授权提交和push。

- [x] 1. 生成清单
- [x] 2. 确认路径与分支
- [x] 3. 加载全局及项目规则
- [x] 4. 检测CodeGraph（未建索引）
- [x] 5. 分支与冲突检查
- [x] 6. 变更及敏感信息审查
- [x] 7. 确认Bun/TypeScript工具链
- [x] 8. 类型检查通过
- [x] 9. 格式检查通过（无lint/format配置）
- [x] 10. 310项测试通过
- [x] 11. 质量问题检查
- [x] 12. 完成内置语义审查
- [x] 13. 用户已授权提交
- [x] 14. 起草Conventional Commit信息
- [x] 15. 作者一致、精确暂存
- [x] 16. 用户已授权push（结果以远程核验为准）
- [x] 17. 复盘：无技能更新需求

验证：`bun run typecheck`、`bun test`（310/0）、`bun run build`、`git diff --check`，以及`node --check src/web/public/app.js`。原生Codex调度故障根因未确认。
