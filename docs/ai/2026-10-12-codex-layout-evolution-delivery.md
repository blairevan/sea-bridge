# Codex 布局演进 Phase A-E 实施与验证记录

## v1.1.21 Codex 终态错误卡片发布

- rollout 的 canonical `error.message` 作为独立 error role 消息按原始顺序显示；仅允许 task_complete、turn_complete、turn_aborted，文本最多 4000 字符，不透出结构化内部字段。
- Web 使用独立橙色错误卡片，无助手元信息，不进入助手 Markdown、快捷操作或最终答复判定。
- 版本递增至 v1.1.21，更新 immutable 静态资源键。
- 发布状态与实机探活结果将在部署后补记。

## v1.1.20 活动流展示调整

阶段性 commentary 在已读取范围内完整展开，移除 280px 限高和内部滚动。连续工具项聚合为紧凑摘要，末尾保留最新工具记录；最新记录不代表已验证的进行中状态。由消息区统一跟随最新，用户查看旧内容时不抢滚动。后端移除末尾 25 条截断，仍保留原有有界文件读取契约。

- 发布快照：`/opt/app/aitools/sea-bridge-releases/sea-bridge-v1.1.20-20261012-185114`。
- SQLite 一致性备份：`~/.config/sea-bridge/backups/20261012-185114/state.sqlite3`，`PRAGMA quick_check=ok`。
- LaunchAgent 重载首次 bootstrap 返回错误 5；确认旧进程退出、7310 已释放后单独重试成功。当前 LaunchAgent running，PID 50346。
- 本机首页、`/app.js?v=1.1.20`、`/app.css?v=1.1.20` 均 HTTP 200，HTML 确认版本为 v1.1.20。

- 日期：2026-10-12
- 仓库：`/opt/app/aitools/sea-bridge`
- 基线版本：`v1.1.8`
- 当前状态：代码已完成并通过门禁；尚未 commit / push / deploy / bump version

## 1. 已完成范围

### Phase A-C（v1.1.8 已有）

- Live Activity Card、可见文本 Quick Action Pills、Loaded Turn Rail、Composer Hub。
- 修复移动端深色主题“已加载轮次”抽屉的低对比问题：轮次项不再继承全局浅绿 primary button 背景，普通/active/hover/focus 均使用深色 surface 与高对比文字。
- 当前工作区在 Phase A-C 基础上进一步对齐 Codex 原生 Composer 交互：有草稿时显示 `↑ 发送`；空草稿且会话 active 时显示 `⏹ 中断`。停止能力 unavailable/unverified 时仍保留停止形态但 disabled，不因 owned / external 来源不同改变布局。
- 目标 Mac 上完成 owning App Server session 的 `turn/interrupt` Contract Gate。
- Sea-Bridge-owned exact turn 使用原 owning session 中断，并用 `expectedTurnId` 防止 stale request 误停后续 turn。
- Web interrupt endpoint、CSRF/auth、terminal evidence、safe audit 与 writer release 语义已落地。

Phase B 历史真实 Gate 环境：

- Darwin 25.5.0 arm64；
- `/Users/zhuhaijun/.bun/bin/codex`；
- `codex-cli 0.147.0`；
- same owning session interrupt 被接纳；
- matching `turn/completed(status=interrupted)` 到达；
- `thread/unsubscribe` 成功；
- fresh App Server session 可 resume 同一测试 thread 并启动后续 turn。

### Phase D：Session Metadata Contract（本轮完成）

生产 Web 链路继续保持 App Server read path，不扩大为浏览器直读 native SQLite：

```text
CodexReadService
  -> CodexCatalogStore
  -> SessionMetadataResolver
  -> CodexWebSource
  -> WebSessionMeta
  -> Composer badges
```

实现内容：

1. `CodexReadService` 从 App Server thread wire allowlist 读取 `model / reasoningEffort`；
2. `CodexCatalogStore` 持久化上述 thread snapshot；
3. Hook session state 只保存 allowlist `model / permission_mode` 与必要时间证据，不保存 prompt、tool input、reasoning 或未知 Hook payload；
4. owned Action turn 保存实际 model / sandbox / approval 参数，作为该 active turn 的强事实；
5. `SessionMetadataResolver` 按字段合并 Action、fresh Hook 与 thread snapshot；
6. model catalog 只补 display name，不参与 model 事实选择；
7. `permission_mode` 未完成语义映射 Gate，因此不被翻译为 Web sandbox/approval；
8. Composer 支持字段级展示，例如 `GPT-5.6 · 中 · Full Access · 免审批`，缺失字段独立省略，不补默认值；`reasoningEffort=none` 按缺失处理，idle 状态文案不常驻；
9. 当前 Codex model 展示位置已直接改为原生下拉选择器：idle 时实时加载 `model/list` 并可直接切换；running / approval / reconnect 时同一控件 disabled，并像停止按钮一样用 `opacity:.45 + cursor:not-allowed` 明确表现不可用，同时提供 title/ARIA 原因；不再增加模型弹窗或说明文案。后端仍通过 `thread/resume -> thread/settings/update -> thread/read` 修改并确认该 thread 后续模型，active writer / unknown-idle 等状态继续 fail closed；
10. 模型切换只作用于该 thread，不修改全局默认模型，不把 model 猜测性塞进 `codex queue`；审计不记录 model id；
11. 模型切换成功或失败统一在顶部消息区反馈：成功显示 success；业务失败显示 sticky error；网络失败进入 reconnect 时顶部连接消息保留“模型切换失败”的上下文；
12. auth / redaction policy invalidation 时 `sessionMeta` 与 turn control 一并清理。

兼容层：`CodexThreadStore` 支持 native `model / reasoning_effort / sandbox_policy / approval_mode` 的固定 allowlist schema probing，但当前生产 Web 数据链路不依赖 native SQLite。

数据库升级采用 additive migration：

- `observed_sessions`: `model`, `permission_mode`, `metadata_observed_at`
- `desktop_codex_catalog`: `model`, `reasoning_effort`

旧数据库迁移已有幂等测试。

### Phase E：Universal Interrupt Provider 化（已收口，external limitation 已实机验证）

已实现：

- `InterruptProvider` 抽象；
- `OwnedAppServerInterruptProvider`，包装现有同-session owned interrupt；
- `InterruptRouter`；
- Web capability 收敛为 provider-independent `scope: "exact_codex_turn"`；
- `interrupt_provider_unverified` 稳定错误；
- `CodexWebSource` 不再把 `not_owned` 当成永久不可控；
- 自动化证明 provider-independent Web capability/API 不依赖 owned 实现；当前 non-owned external active turn 因 Gate FAIL 明确走 unavailable/fail-closed；
- provider 在真正 dispatch 后固定，不允许失败后 fallback 到另一 provider；
- stale turn mismatch 不会自动选择新 turn；
- Web endpoint、CSRF/auth、安全审计与前端按钮无需为 Desktop/CLI 另开第二套协议；
- Composer 单按钮不拆成 Send/Stop 双控件：草稿优先发送，空草稿 active 优先停止；external active writer 因 Gate FAIL 显示 disabled stop，输入草稿后仍按现有 `sendEnabled` 使用 queue/send；owned 首轮若 `sendEnabled=false`，发送形态保持 disabled，不新增未经验证 steer。

当前 production Router 只注册：

```text
OwnedAppServerInterruptProvider
```

## 2. 已验证限制范围

### Desktop / CLI / `codex queue` external active-writer interrupt

**当前目标宿主与 `codex-cli 0.147.0` 上已实机验证不可通过独立 App Server 安全实现。**

目标 Mac Contract Gate 已完成，物理证据见本文第 6 节：

- 独立 App Server 直发 `turn/interrupt` / `turn/steer`：`thread not found`；
- 尝试 `thread/resume`：`already has an active writer`；
- 系统不存在默认共享 app-server control socket；
- 证明当前官方架构使用私有 stdio App Server + 单 writer 隔离，第二实例不能合法接管外部 active writer。

因此生产裁决为：

- 不实现、不注册猜测性的 `ExternalCodexInterruptProvider`；
- `DesktopSameSessionAdapter.interrupt()` 保持 unavailable；
- 不以 `thread/resume` 试探性 takeover；
- 不用 `kill` / `pkill` / `SIGINT` 整个 Codex/Desktop 进程作为正常 turn interrupt；
- non-owned external active turn 返回 `interrupt_provider_unverified` 并 fail closed。

这不是待补代码。只有未来 Codex 上游新增共享控制总线、writer-safe attach/control 或等价官方 contract 时，才需要重新执行新的目标机 Gate。

## 3. 关键竞态与安全语义

### Exact turn binding

所有中断请求继续绑定点击瞬间的：

```text
threadId + expectedTurnId
```

请求到达后绝不重新查询“最新 active turn”作为替代目标。

### Provider pinning

Router 可以跳过一个**尚未 dispatch 且明确不适用**的 provider；一旦某 provider 实际尝试控制该 turn，本次请求立即固定，成功或失败都不会再切换 provider。

### Terminal evidence

provider RPC success 只表示 interrupt 请求已接纳。UI 保持 `正在中断…`，直到 matching terminal evidence 到达；不会在 HTTP 200 后擅自切 idle。

### Privacy boundary

本轮没有把以下内容新增到 Web：

- reasoning 正文；
- tool arguments；
- shell command；
- prompt；
- local absolute path；
- native DB path；
- AppServerSession/socket 等 provider 内部对象。

## 4. 自动化验证

最终门禁：

```bash
bun test
# 477 pass / 0 fail / 2211 expect() calls / 70 files

bun run typecheck
# PASS

node --check src/web/public/app.js
# PASS

bun run build
# PASS
# Sea-Bridge server and Web assets built.

git diff --check
# PASS
```

新增/强化测试覆盖：

- metadata resolver precedence / partial fields / no default inference；
- App Server thread model/reasoning normalization；
- Sea-Bridge catalog metadata persistence；
- native optional metadata compatibility projection；
- Hook allowlist persistence and sensitive-field non-persistence；
- existing DB additive migration idempotency；
- Composer metadata rendering / partial metadata / privacy clearing；
- owned provider exact target；
- Router pre-dispatch selection；
- no fallback after dispatch；
- stale-turn no retarget；
- non-owned external active writer 在当前生产 provider 集合中明确 fail closed，并复用 `exact_codex_turn` 的 unavailable capability；
- `interrupt_provider_unverified` HTTP/UI mapping；
- session-list 轮询不会清空 history-only live activity detail；
- `↓` 回到最新后持续 follow-latest，用户主动上滚才退出；
- live activity 内部流默认跟随最新 commentary/tool 条目，并尊重用户手动上滚阅读旧条目。

全量测试期间曾发现 1 个测试夹具回归：`web-client-policy` 的伪 DOM button 缺少真实浏览器一定存在的 `dataset`。仅修正测试 fixture，没有为生产代码增加不可能 DOM 的兼容分支。最终全量门禁全部通过。

## 5. 发布状态

当前 `package.json` 为 `1.1.20`。Web 静态资源继续以版本号作为一年 `immutable` 缓存键，因此每次已发布后的 JS/CSS 行为变化都必须递增版本：v1.1.10 用于暗色轮次抽屉缓存失效，v1.1.11 收口 `reasoningEffort=none` 与 idle 状态展示，v1.1.12 增加会话模型切换与 Composer send/interrupt 提交语义修复，v1.1.13 将模型交互收口为 Composer 内联下拉选择器并移除二级弹窗/提示，v1.1.14 统一模型切换成功/失败的顶部消息反馈，v1.1.15 修正模型下拉 disabled 状态，v1.1.16 增加阶段性 commentary/tool activity stream，v1.1.17 修复 activity follow-latest、列表轮询覆盖 runtime detail 与内部流停留旧条目的问题，v1.1.18 收口移动端轮次提示：默认隐藏，仅真实用户滚动时显示，并与上下箭头使用相同透明度；v1.1.19 将滚动停止后的提示保留时间从约 1.2 秒延长到 6 秒；v1.1.20 将 Codex canonical terminal error 对齐到消息流中的独立橙色错误卡片。发布后 HTML 应引用新的 `app.css?v=1.1.20` / `app.js?v=1.1.20`。

本轮尚未：

- commit；
- push；
- deploy。

因此本文描述的是**当前工作区已验证实现**，不是已经发布的新版本。目标 Mac External Contract Gate 已完成且判定 FAIL；当前版本线不得把 Desktop / CLI / queue external active-writer interrupt 标为可用。只有 Codex 上游新增共享控制总线、writer-safe attach/control 等新契约并重新通过新的目标机 Gate 后，才能重新评估该能力。

## 6. 目标机 External Interrupt Contract Gate 验证记录 (2026-10-12)

在目标宿主环境（Darwin 25.5.0 arm64, codex-cli 0.147.0）上，针对 Phase E External Codex Interrupt 执行物理实机 Contract Gate：

1. **测试设计**：
   - Writer A 启动独立 App Server 并开启长生成 turn (01a12ec2-686f-7fb0-ab1a-ffbe0feb8747)；
   - 独立启动的 Writer B 尝试接入并控制该 thread。
2. **实测物理响应**：
   - 跨实例直发 turn/interrupt：返回 {"code":-32600,"message":"thread not found: 01a12ec2-66fe-7922-9789-ae4af0fa0cf4"}；
   - 跨实例尝试 thread/resume：返回 {"code":-32600,"message":"thread 01a12ec2-66fe-7922-9789-ae4af0fa0cf4 already has an active writer"}；
   - 跨实例尝试 turn/steer：返回 {"code":-32600,"message":"thread not found: 01a12ec2-66fe-7922-9789-ae4af0fa0cf4"}；
   - 系统中不存在全局共享 daemon socket（/Users/zhuhaijun/.codex/app-server-control/app-server-control.sock 不存在）。
3. **裁决结论**：
   - **Gate FAIL**：当前官方 codex app-server 为每个客户端维护严格私有的 stdio 实例与单 writer 互斥锁，跨进程 App Server 无法介入外部活跃 turn。
   - 严格坚守安全底线：禁止伪造中断、禁止跨实例强抢锁、禁止破坏性进程信号杀进程。
   - 生产环境统一对 non-owned turn 保持 interrupt_provider_unverified fail-closed。

## 7. 运行态阶段性活动流上线记录 (v1.1.16, 2026-10-12)

根据真实 Codex 原生运行态表现与用户要求，活动卡片正式从单一的“执行中 + 计时器”升级为完整的**阶段性结果与工具活动流**：

- **阶段性思考与说明 (Commentary)**：从活跃 turn 的 rollout 记录中提取 `role: "assistant"` 且 `phase: "commentary"` 的文字，原样呈现在活动卡片的内容流中；
- **微观工具活动 (Tools & Commands)**：从活跃 turn 的 `CommandExecution` 与 `function_call` 记录中提取动作摘要（读取文件 📖、搜索 🔍、命令执行 🛠），与阶段性陈述按发生时序穿插展示；
- **卡片交互与自适应**：无条目时仅显示耗时标题；产生条目时展开细分割线与纵向活动流（带 max-height 滚动，支持暗色主题自适应）；任务完成时活动卡片平滑移除并由最终答复接管；
- **防缓存版本递增**：升级至 `v1.1.16`，确保 Safari 等移动端浏览器加载最新样式与脚本。

## 8. 活动流 follow-latest 修复记录 (v1.1.17, 2026-10-12)

针对 iPhone 实机出现的“点击 ↓ 后轮询又重新出现 ↓、活动流停在旧条目、最新 commentary 看不到”问题，定位并修复了三处状态覆盖：

- `loadSessions()` 的 3 秒列表轮询不再用摘要对象清空当前会话的 `activeTurnItems / startedAt / turnControl`，history refresh 到达前继续保留最后一次已验证 runtime detail；
- `followLatest` 不再在每次 `loadHistory()` 结束时强制归零。用户点击 `↓` 后持续跟随后续消息/activity 增长；只有用户主动把消息区滚离底部才退出跟随；
- `.live-activity-stream` 首次渲染和持续更新时默认跟随尾部，因此展示最新 commentary/tool 条目；若用户手动在活动流内部上滚，则保留其阅读位置，点击“回到最新”会重新恢复尾部跟随；
- history DOM 重建时同时失效 live activity DOM/signature cache，避免新卡片因为复用旧 signature 而出现空内容或旧内容；
- commentary 仍仅指 Codex rollout 中明确标记为 `phase=commentary` 的阶段性可见文本，不读取或推断模型私有 chain-of-thought。

## 9. 移动端轮次提示收口 (v1.1.18, 2026-10-12)

针对 iPhone 上 `当前第 X 轮 · 已加载 N 轮` 在 follow-latest/轮询时反复闪现的问题：

- 提示默认隐藏，仅在消息区出现真实 `touchmove` / `wheel` 滚动意图后的 scroll 事件中展示；程序化 follow-latest、轮询和 activity 自增长不再触发；
- 提示透明度调整为 `.5`，与上下浮动箭头一致；
- 位置从消息区右侧中部下移到消息区底部、靠近 Composer 输入框上边沿；
- 用户停止滚动约 6 秒后自动隐藏，点击后仍可打开已加载轮次抽屉。

## 10. Codex 终态错误消息对齐 (v1.1.20, 2026-10-12)

针对 Codex 原生会显示 `exceeded retry limit, last status: 429 Too Many Requests` 等终态失败，而 Sea-Bridge 只剩用户输入、错误被 transcript parser 丢弃的问题：

- `readCodexTranscript()` 识别 canonical `task_complete / turn_complete / turn_aborted` 中的 `error.message`，按 rollout 原始 offset 插入会话消息流；
- 错误作为独立 `role=error`，不会伪装成 assistant final reply，也不会触发快捷操作胶囊或“收到新的最终回复”逻辑；
- 只暴露最多 4000 字符的 `error.message`，不透传 `codex_error_info / additional_details` 等结构化错误字段，HTTP 层仍经过现有 redaction；
- 深色主题使用接近 Codex 原生的暗底橙色文字/边框，浅色主题使用浅橙背景与深橙文字；错误块不显示“助手”元信息；
- 回归覆盖 429 文本时序、结构化字段不泄漏、独立错误 DOM 与深浅主题样式。
