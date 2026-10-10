# Codex 运行时消息过滤发布清单

## 范围与授权

用户授权提交、push、merge、部署。分支 fix/codex-runtime-message-filter，发布版本 1.1.7。
仅过滤历史展示中的 skill 与 turn_aborted 注入块；原始记录、数据库和账号配置不变。不新增依赖。

## 编号清单

- [x] 1. 确认项目规则、特性分支、Git 身份和 GitHub 仓库账号；无冲突、无无关改动，分支与 origin/main 同步。
- [x] 2. 核查近三天真实 user 记录的开头标签，确认新增两类过滤目标，不对未知标签泛化。
- [x] 3. TDD：新测试先复现 1 fail；实现后定向 14 pass，原始文件不变、分页与 exact-message 一致。
- [x] 4. 只读语义复核、类型检查、全量测试、构建和 diff 检查通过；无独立 lint/format 脚本。独立 Cursor 审查未返回输出而停止，不记为通过。
- [ ] 5. 精确暂存提交并 push，创建 PR 后 squash 合入 main；保留分支。
- [ ] 6. 从已合并 main 构建发布快照，备份旧 plist 和 SQLite，重新加载应用 LaunchAgent。
- [ ] 7. 检查本机/公网版本、静态资源、认证保护、进程及数据库健康；保留回退快照。

## 验证命令

```bash
bun run typecheck
node --check src/web/public/app.js
bun test tests/web-runtime-envelopes.test.ts tests/web-codex-transcript.test.ts
bun test
bun run build
git diff --check
```

原始会话的真实解析验证：3 页中 visibleInjectedSkills=0，preservedServerSkillCalls=1。
手机登录后的视觉效果仍需要刷新验收，不用静态 HTTP 200 代替真实页面交互。

## 发布前复核

- 全量 437 pass / 0 fail / 1981 expect / 67 files；类型检查、JS 语法检查、构建及 diff 检查通过。
- 语义复核覆盖开头锚定、完整块识别、非空 name/path、原始记录不变、分页字节身份及 exact-message 复用。未发现剩余阻断问题。
- SQLite 备份使用原生 backup API，immutable 只读 quick_check 为 ok；管理员与设备会话数量保持不变。
- 核对数据库 schema 后使用 web_device_sessions 进行统计，未修改数据库。
- 私有回退备份位于本机 sea-bridge 配置目录的 backups/20261010-202300-runtime-filter；不纳入版本库。
