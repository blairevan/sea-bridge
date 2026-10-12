# Codex 布局演进 Phase A-E 实施与验证记录

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
8. Composer 支持字段级展示，例如 `GPT-5.6 · 中 · Full Access · 免审批`，缺失字段独立省略，不补默认值；
9. auth / redaction policy invalidation 时 `sessionMeta` 与 turn control 一并清理。

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
# 465 pass / 0 fail / 2118 expect() calls / 70 files

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
- `interrupt_provider_unverified` HTTP/UI mapping。

全量测试期间曾发现 1 个测试夹具回归：`web-client-policy` 的伪 DOM button 缺少真实浏览器一定存在的 `dataset`。仅修正测试 fixture，没有为生产代码增加不可能 DOM 的兼容分支。最终全量门禁全部通过。

## 5. 发布状态

当前 `package.json` 为 `1.1.9`。

本轮尚未：

- bump version；
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
