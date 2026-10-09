# Sea-Bridge 浏览器图标交付

## 目标与范围

采用用户确认的“海上之桥”：深海蓝圆角底、白色桥拱和青色海浪。
新增 SVG 浏览器图标及 180×180 PNG 手机主屏幕图标，接入页面、静态资源白名单和构建产物。
版本递增至 v1.1.5，沿用已有资源版本缓存策略。无新增依赖，不修改账号、数据库结构或会话逻辑。

## 编号交付清单

- [x] 1. 核对规则、分支、作者和远端账号；仅包含本次任务改动，无冲突，分支与远端 main 基线一致。
- [x] 2. 审查实现范围、敏感信息、资源白名单及构建复制路径；测试先失败于缺失图标，再通过。
- [x] 3. 完成兜底语义审查、严格类型检查、聚焦及全量测试、构建和差异检查；独立 Cursor 审查数分钟未返回，未计为通过。
- [ ] 4. 精确暂存、Conventional Commit 提交和推送。
- [ ] 5. 创建 PR、检查冲突及状态、Squash 合入 main；保留特性分支。
- [ ] 6. 创建发布快照，备份旧 LaunchAgent 配置与运行数据库，再切换应用服务。
- [ ] 7. 回读本机与公网版本、图标响应及字节一致性、未认证接口保护和服务状态。

## 验证命令

```bash
bun run typecheck
node --check src/web/public/app.js
git diff --check
bun test tests/web-build.test.ts tests/web-static.test.ts
bun test
bun run build
```

项目没有配置独立 lint/format 脚本，本次保持原有格式，不安装工具或重写无关文件。
构建测试覆盖图标打包、HTTP MIME、nosniff、PNG 文件签名及 180×180 尺寸。
手机添加到主屏幕的实际系统展示不以服务端测试替代。

## 提交前审查与发布准备

- 未发现阻断问题。图标仍受既有 Host/loopback 来源校验保护；不新增认证接口，不修改 CSP。
- SVG 不含脚本、外链或嵌入内容；PNG 签名和尺寸由构建集成测试验证。
- 资源经固定白名单提供，页面携带应用版本，沿用已有不可变缓存及旧版本 no-store 策略。
- 全量验证：431 pass、0 fail、1927 expect、66 files；聚焦验证：5 pass、0 fail。
- 已创建 `sea-bridge-v1.1.5-20261009-162802` 发布快照，全部打包文件与 dist 逐字节一致。
- 已备份旧应用 plist 与 SQLite 至 `~/.config/sea-bridge/backups/20261009-162802/`，quick_check 为 ok。
- 新旧数据库各有 1 个管理员记录、7 个设备会话；备份不包含在 Git 提交中。
- 最初 SQLite URI 路径打开失败，改用明确文件路径及 `-readonly` 后备份和验证成功。
