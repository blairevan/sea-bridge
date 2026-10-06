# 实施计划

- [x] 新增 `src/desktop/codex-queue-recovery.ts`：轮询、10 秒阈值、去重、重新校验、日志与停止等待。
- [x] 新增 `tests/codex-queue-recovery.test.ts`，先运行失败测试，再实现恢复器；覆盖阈值、空闲条件、失败、并发、队列变动与未知读取。
- [x] 在 `CodexWebSource` 增加空闲证据核验，共用原生状态及首轮所有权保护；在 `src/main.ts` 接入共享实例与服务启动/停止。
- [x] 移动 HTML 按钮到设置，显示当前目标并保留确认操作；增加 UI 与空闲条件回归。
- [x] 运行 `git diff --check`、`bun run typecheck`、定向及完整 `bun test`，用临时目录构建；记录验收范围。

## 验收结果

- `git diff --check`：通过。
- `bun run typecheck`：通过。
- `bun test tests/codex-queue-recovery.test.ts tests/codex-desktop-open.test.ts tests/web-message-ui.test.ts`：60 项通过。
- `bun test`：423 项通过，0 失败。
- `bun run scripts/build.ts /var/folders/fg/zgy5jzn56lbdjfhkv7pcwks00000gn/T/web-build-codex-idle-recovery`：通过。首次 `/tmp` 输出路径被脚本保护拒绝，改用核实的系统临时目录后成功；正式 dist 未修改。
- package.json 没有 lint/format 脚本；未引入工具或依赖。
- 未提交、推送或重启生产服务；尚未在本轮实测手机设置页与真实自动恢复。用户此前确认手动打开能恢复。

## 顶部提示补充验收

- [x] 恢复器发出 `open_requested` / `failed` 结果回调，通知故障不影响激活结果。
- [x] WebRuntime 转发至认证 SSE，重新检查设备撤销/过期状态，只发送恢复元数据和显示策略版本。
- [x] 浏览器过滤非当前会话、旧连接、过期事件和不同显示策略版本；通过现有顶部消息区显示请求结果。
- [x] 补充服务端结果、通知异常、SSE 授权、UI 策略和旧连接竞争回归。
- `bun test`：428 项通过，0 失败。
- `bun run typecheck`、`node --check src/web/public/app.js`、`git diff --check`：通过。
- `bun run scripts/build.ts /var/folders/fg/zgy5jzn56lbdjfhkv7pcwks00000gn/T/web-build-codex-idle-recovery`：通过。
- 尚未部署，未本轮实测真实手机实时提示。离线/后台恢复事件不补发；提示仅说明打开请求结果。

## 部署追加记录

用户已授权部署；v1.1.0 已发布，本机和公网版本及资源匹配，观察到真实自动激活与队列执行。旧版配置和一致性数据库备份保留。详情：[部署验收](../../ai/2026-10-06-codex-idle-recovery-deployment.md)。
