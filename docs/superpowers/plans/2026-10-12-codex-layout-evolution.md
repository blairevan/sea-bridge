# Sea-Bridge 借鉴 Codex 原生布局体验升级实施计划 (Implementation Plan)

### v1.1.23 会话列表状态投影

历史会话列表状态改为复用 Desktop observer 已持久化的最新 turn observation，但仅在 observer `lastRecencyAtMs` 与 catalog 当前 recency 完全一致时生效；`inProgress -> running`，可靠 terminal -> idle。recency 不一致、baseline 未完成或 interrupted 仍属 provisional 时继续 unknown，避免用旧终态覆盖新任务。

### v1.1.22 移动端附件与浮层避让

扩展用户附件 envelope 解析以兼容 `Files pasted by the user`，只保留正文与安全 basename；文本附件不创建图片加载按钮。轮次提示出现时给 `↓` 设置临时避让状态，6 秒提示隐藏后恢复原位，并补充移动端 UI 回归。

### v1.1.21 终态错误卡片

终态事件的 canonical 错误文本独立渲染；覆盖允许的三类终态、敏感结构字段隔离、消息时序及橙色明暗主题样式。

### v1.1.20 活动流调整

已移除局部限高及内部吸底状态，增加相邻工具聚合，保留已读取 commentary，统一由外层消息区跟随。回归覆盖工具聚合、阶段性文本保留及用户查看旧消息时不抢滚动。真实工具进行中状态需后续明确数据契约，不以最后记录冒充。

- **Goal**: Phase A-C 已完成 Codex 原生布局核心体验与 exact owned-turn 中断。后续以两个独立能力域继续收口：Phase D 建立可信 Session Metadata Contract；Phase E 建立 Universal Codex Interrupt provider 架构，使所有具备 exact active-turn 证据且存在已验证 provider 的 Codex running 会话都能统一停止。
- **Architecture**: 保留 Sea-Bridge 现有 REST + SSE + 3 秒轮询数据链路。新增后端 `SessionMetadataResolver` 负责逐字段事实聚合，新增 `InterruptRouter` 负责 exact-turn provider 选择；前端只消费稳定的 metadata / capability 契约，不直接感知 AppServerSession、Desktop/CLI 来源或 native schema 差异。v1.1.8 的 owning-session interrupt 作为首个已验证 provider 保留，external provider 必须单独 Gate 后启用。
- **Tech Stack**: TypeScript, Bun test, 原生 Web API (DOM, CSS, IntersectionObserver), Node/Bun child_process 与 JSON-RPC。
- **Reference Spec**: [docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md](/opt/app/aitools/sea-bridge/docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md:1)
- **Plan Status**: 2026-10-12 implementation updated；Phase A-C 已上线 v1.1.8；Phase D Session Metadata Contract 已实现；Phase E 已完成 provider/router 架构与 owned provider 接线，Phase E 已在目标 Mac 完成 External Provider 真实 Contract Gate 验证，物理证据确认官方多实例 writer 严格隔离（FAIL），生产环境严格保持 fail-closed。

### 2026-10-12 实施状态

- **Composer 回车发送偏好**：设置页可切换“回车发送，Shift+回车换行”，浏览器本地保存且默认关闭；普通 Enter 仅在有草稿、发送模式可用且输入法未组字时提交。加入键盘行为回归测试，版本升至 v1.1.24 以更新 immutable 静态资源键。

- **Phase A 已实现**：安全活动卡片、可见选项快捷填入、已加载轮次导航、Composer 控制台化均已落地，并补充 UI / 安全 / 竞态回归测试。
- **共享 ownership 已收口**：`CodexAppServerClient` 维护 `starting / running / interrupting` 的 exact owning turn，并保留 owning `AppServerSession`；`CodexWebSource` 读取同一事实源，因此 Web 与 Telegram 创建的 Action 首轮在 writer 释放前都不会被 Web 错误开放续发。
- **Phase B 真实 Contract Gate 已通过**：目标宿主为 Darwin 25.5.0 arm64，真实验证使用 `/Users/zhuhaijun/.bun/bin/codex`（`codex-cli 0.147.0`）。同一 owning App Server session 对 exact active turn 调用 `turn/interrupt` 被接纳，随后同一通信流收到官方 `turn/completed(status=interrupted)` 且带 completion evidence；`thread/unsubscribe` 成功后，新建的第二个 App Server session 能 `thread/resume` 同一测试 thread 并启动下一 turn，证明 writer ownership 已释放。
- **Phase C 已实现**：新增 exact owned-turn `interruptOwnedTurn()`、Web `turnControl` 投影、CSRF 保护的 interrupt endpoint、安全审计和前端 `⏹ 中断 / 正在中断…` 状态机。所有请求绑定点击瞬间的 `expectedTurnId`，不自动改停后续新 turn。
- **Phase D 已实现**：App Server thread catalog、Hook allowlist metadata 与 owned Action 参数经 `SessionMetadataResolver` 逐字段聚合；Composer 只显示真实存在的 model / reasoning / execution policy，不补默认值；旧数据库采用 additive migration 兼容升级。
- **Phase E provider 化已实现**：新增 `InterruptRouter` 与 `OwnedAppServerInterruptProvider`，Web wire scope 收敛为 provider-independent `exact_codex_turn`；provider 一旦实际 dispatch 即固定，失败不自动 fallback，不会重新选择新 turn。
- **External provider 仍未启用**：在目标 Mac（Darwin 25.5.0 arm64, codex-cli 0.147.0）上物理实测，独立 App Server 尝试 thread/resume 外部活跃 thread 明确返回 -32600 already has an active writer，调用 turn/interrupt 或 turn/steer 明确返回 -32600 thread not found；本地亦无共享 daemon control socket。根据验收规则，跨实例 App Server 中断 Gate 裁决为 FAIL；生产环境严格保持 fail-closed，非 owned turn 统一返回 interrupt_provider_unverified，绝不猜测性尝试伪中断或破坏性杀进程。
- 当前自动化回归：`bun test` **477 pass / 0 fail**、**2211 expectations**（70 个测试文件）；`bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 全部通过。

---

## 1. 实施原则与禁止事项

1. **状态只来自已验证证据**：`running / idle / waiting_external_approval / activeTurnStartedAt / activeTurnId` 均不能由 UI 猜测。
2. **running 不等于 interruptable**：只有后端明确返回 exact-turn 且已验证 provider capability 时，Web 才出现可点击中断按钮；provider 可以是 v1.1.8 的 owned session，也可以是未来 Gate PASS 的 external provider。
3. **中断意图绑定点击瞬间的 `expectedTurnId`**：请求到达后不得重新寻找“当前新 turn”并停止它。
4. **不扩大 rollout Web 投影**：Phase A 不返回 reasoning、tool arguments、shell command、本地绝对路径或原始工具事件。
5. **快捷操作没有隐藏 payload**：按钮可见文本就是写入输入框的文本；不支持 `{prompt="隐藏指令"}` 覆盖。
6. **不伪造历史完整度**：轮次导航只表达“当前已加载并已执行的 user turns”，不显示假的全局 `X / Y`。
7. **不吞质量门禁失败**：测试、typecheck、build、JS syntax、`git diff --check` 任一失败均为阻断，不允许 `|| true`。
8. **任何新 interrupt provider 的 mock 都不能替代真实 Contract Gate**：单元测试只能证明 Sea-Bridge 自己的逻辑，Desktop / CLI / queue 等 external provider 仍必须在目标 Mac 当前 Codex 版本上实测。
9. **Metadata 逐字段 fail closed**：model / reasoning / sandbox / approval 可独立存在；未知字段省略，不从默认配置、catalog 或其他字段推断。
10. **控制与 metadata 解耦**：能读到 model/permission 不代表能 interrupt；能观察 running 不代表存在控制 provider。

---

## 2. 涉及文件与职责划分

### Phase A

- `src/web/public/index.html`
  - Composer 下层控制栏；
  - 桌面轮次轨、移动轮次胶囊/抽屉挂载点。
- `src/web/public/app.css`
  - `.live-activity-card`；
  - `.action-pills` / `.action-pill`；
  - `.turn-rail` / `.turn-tick` / mobile turn indicator；
  - Composer control hub；
  - `prefers-reduced-motion` 降级。
- `src/web/public/app.js`
  - 活动卡片状态同步；
  - 安全快捷选项提取与填入；
  - 已加载轮次模型、observer 生命周期和移动端抽屉；
  - Composer 状态渲染。
- `tests/web-message-ui.test.ts`
  - DOM 安全、活动卡片、快捷选项、轮次轨、Composer 主状态测试。
- `tests/web-ui-races.test.ts`
  - 历史刷新、stale response、DOM replace 后 observer 重绑、滚动/断线状态竞态测试。

### Phase B/C

- `src/desktop/codex-app-server-client.ts`
  - owning-turn 状态成为单一事实源；
  - `interruptOwnedTurn()` 只复用 owning session。
- `src/web/sources/types.ts`
  - 增加窄的 `WebTurnControl` / interrupt capability 投影。
- `src/web/sources/codex.ts`
  - 从 Action Client 读取 Sea-Bridge-owned turn；
  - send gating 与 interrupt capability 使用同一 ownership 事实；
  - Phase C 只把已通过 Gate 的 owned provider 标记为 interruptable；Phase E 已完成 external Gate，并因单 writer 隔离明确不注册 external provider。
- `src/web/http.ts`
  - `POST /api/sessions/codex/:id/interrupt`；
  - 复用现有 auth / same-origin / CSRF / post-body revalidation；
  - 稳定错误码与审计记录。
- `src/main.ts`
  - 向 `CodexWebSource` 注入扩展后的 Action Client 能力。
- `tests/codex-app-server-client.test.ts`
  - owning turn 生命周期、同 session interrupt、重复请求和 release。
- `tests/web-codex-source.test.ts`
  - turn control capability、非 owned 拒绝、send gating。
- `tests/web-http.test.ts`
  - interrupt endpoint、CSRF、参数校验、错误码。
- `tests/web-message-ui.test.ts` / `tests/web-ui-races.test.ts`
  - 中断按钮 exact turn 状态机与 stale-turn 竞态。
- `docs/ai/2026-10-12-codex-layout-evolution-delivery.md`
  - 实施记录、目标机 Codex 版本、Phase B 原始 Contract Gate 结果和最终验证结果。

> 不新增独立的 `tests/fixtures/app-server-mock.ts`。当前 `tests/codex-app-server-client.test.ts` 已有可复用的 `MockProcess`；除非测试复杂度实际增长到需要抽取共享 fixture，否则避免为了计划预先增加抽象。

### Phase D：Session Metadata Contract

- `src/desktop/codex-thread-store.ts`
  - 探测 native `threads` 可选 metadata 列；
  - 使用预定义固定 SQL profiles 读取 `model / reasoning_effort / sandbox_policy / approval_mode`，不接受动态列名。
- `src/desktop/session-state.ts` / `src/desktop/providers/codex-hook.ts`
  - 仅保存 allowlist live metadata（如 `model`）；
  - 不持久化 prompt、tool input、reasoning；
  - `permission_mode` 在语义映射未验证前保持独立，不直接翻译成 sandbox/approval。
- `src/desktop/session-metadata-resolver.ts`
  - 按字段 scope/freshness 合并 Action、Hook、native snapshot；
  - 冲突无法裁决时省略字段。
- `src/web/sources/types.ts` / `src/web/sources/codex.ts`
  - 投影稳定 `WebSessionMeta`。
- `src/web/public/app.js` / `app.css`
  - Composer metadata badges；字段独立显示。
- tests
  - schema compatibility、resolver precedence、stale/conflict、redaction/privacy、partial metadata UI。

### Phase E：Universal Codex Interrupt

- `src/desktop/interrupt-provider.ts`
  - 已实现 exact-turn provider interface、`OwnedAppServerInterruptProvider` 与 `InterruptRouter`；external provider 尚未注册。
- `OwnedAppServerInterruptProvider`
  - 对现有 `CodexAppServerClient.interruptOwnedTurn()` 做 provider 封装，行为不变。
- `ExternalCodexInterruptProvider`
  - 当前不接入：目标 Mac / `codex-cli 0.147.0` 真实 Contract Gate 已 FAIL；只有上游控制 contract 改变并重新 Gate PASS 后才重新评估。
- `src/web/sources/codex.ts`
  - 从 router 获取 capability / interrupt，不再把 `not_owned` 当成永久不可控语义。
- `src/web/http.ts`
  - 保持现有 `POST /api/sessions/codex/:id/interrupt` 协议；只扩展稳定 provider 错误映射，不新增来源特定 endpoint。
- tests / target-machine gate
  - stale-turn、provider pinning、duplicate、writer residue、unsupported version、Desktop/CLI/queue 真实来源取证。

---

## 3. Phase A：纯 UI / 已有安全数据

### Task 1: 运行态安全活动卡片

**目标**: 对当前选中会话显示可靠的运行态、审批态和断线态；只有存在 `activeTurnStartedAt` 时才显示耗时。活动卡片不进入历史持久化，也不依据最终回答文本自行猜测 turn 已结束。v1.1.16 已追加受限 commentary/tool activity stream；v1.1.17 进一步修正 follow-latest 与轮询状态覆盖问题。

#### Step 1.1 — 先补失败测试

在 `tests/web-message-ui.test.ts` / 必要时 `tests/web-ui-races.test.ts` 增加：

1. `running + activeTurnStartedAt`：消息流尾部有 `.live-activity-card`，显示 `执行中` 和基于绝对时间计算的耗时；
2. `running + startedAt unknown`：仍可显示 `执行中`，但不显示伪造计时；
3. 多次刷新、visibility/foreground 恢复后，耗时继续根据绝对 `startedAt` 计算，不从 0 重置；
4. `waiting_external_approval`：活动卡片显示等待 Telegram 审批；
5. `idle`：活动卡片移除；
6. 仅出现 assistant final reply、但服务器仍返回 `running` 时，不自行移除活动卡片；
7. `state.paused` / transport disconnected 且最后已知状态为 running 时，显示 `连接重连中 · 最后已知执行中`，禁止把它当作新的控制事实；
8. 活动卡片 DOM 中不得出现 tool args、reasoning、shell command 或绝对路径字段。

运行：

```bash
bun test tests/web-message-ui.test.ts tests/web-ui-races.test.ts
```

确认新增用例先失败。

#### Step 1.2 — 最小实现

在 `app.js` 实现 `syncLiveActivityCard()`：

- 复用 `state.selected.state` 和 `state.selected.startedAt`；
- 与现有 `renderSessionStatus()` 共用同一个时间事实；
- 每秒本地更新只做显示，不改变 session state；
- DOM 全部通过 `node()` / `textContent` 构建；
- `loadHistory()`、session selection、disconnect/reconnect、`renderSessionStatus()` 都能触发同步；
- 活动卡片属于 transient UI，不能加入 `state.messages`。

#### Step 1.3 — 验证并提交

v1.1.17 回归额外要求：

1. session-list 轮询不能清空 history-only `activeTurnItems / startedAt / turnControl`；
2. 点击 `↓` 后 follow-latest 持续跨轮询生效，直到用户主动上滚离开底部；
3. live activity 内部流默认滚到最新条目；用户主动上滚后保留阅读位置；
4. history DOM 重建后 activity DOM/signature 同步失效并重建，最新 commentary 不得因旧 signature 消失。

v1.1.20 终态错误对齐额外要求：

1. `task_complete / turn_complete / turn_aborted` 的 canonical `error.message` 按 rollout 原始时序进入 transcript；
2. 只投影 bounded `error.message`，`codex_error_info / additional_details` 等结构化字段不得进入 Web；
3. 错误使用独立 `role=error`，不能被识别为 assistant final reply、不能触发快捷操作胶囊；
4. 深浅主题均使用明显的橙色错误卡片，视觉语义与 Codex 原生失败块一致。

```bash
bun test tests/web-message-ui.test.ts tests/web-ui-races.test.ts
node --check src/web/public/app.js
git diff --check
```

通过后提交：

```bash
git commit -m "feat(web): add evidence-based live activity card"
```

---

### Task 2: 安全快捷操作胶囊

**目标**: 只从 assistant 最终回复的可见文本中提取结构明确的短选项。点击胶囊只填入输入框并聚焦，不自动发送。

#### Step 2.1 — 先定义允许语法

第一阶段只允许：

- `选项 N：文本` / `选项 N: 文本`；
- `回复「文本」...` 这类明确引用式引导；
- 可选的安全显式标记 `:codex-followup[文本]`，其可见 label 与填入文本必须完全一致。

明确拒绝：

- `{prompt="..."}` 或任何隐藏 payload 属性；
- 单凭“一镜到底 / 确认 / Worktree”等关键词推断 action；
- code fence、blockquote、table 内的候选；
- 超过 120 字符的候选：**直接忽略，不截断后发送**，避免按钮显示文本与实际 payload 不一致。

最多渲染 4 个。

#### Step 2.2 — 先补失败测试

测试至少覆盖：

1. 允许语法生成胶囊；
2. 普通段落关键词不生成；
3. fenced code、table、blockquote 不生成；
4. 带隐藏 `prompt=` 属性的显式标记不生成；
5. 超长候选忽略；
6. 最多 4 个；
7. 点击后 `#prompt.value === pill 可见完整文本`；
8. 点击后 focus + `resizeComposer()` 生效；
9. 不调用 `submitWrite()` / fetch；
10. DOM 使用 text node，不产生 HTML 执行。

#### Step 2.3 — 最小实现与验证

在 `app.js` 实现纯函数 `extractActionPills(text)`，再由消息 renderer 挂载；不要把启发式散落在 `renderMarkdown()` 多处分支。

运行：

```bash
bun test tests/web-message-ui.test.ts
node --check src/web/public/app.js
git diff --check
```

提交：

```bash
git commit -m "feat(web): add safe visible quick-action fills"
```

---

### Task 3: 已加载轮次指示轨

**目标**: 对当前已加载、已经进入执行历史的 user messages 建导航索引。queued message、assistant message、未加载历史均不计入“轮次”。

#### Step 3.1 — 先补失败测试

覆盖：

1. 只对无 `deliveryState` 的 user message 建刻度；
2. queued / queue_unknown 不进入轮次；
3. `loadHistory(true)` 加载更早历史后刻度增加；
4. 最新轮询合并 history 后不丢旧刻度；
5. `IntersectionObserver.root === #messages`；
6. `replaceChildren()` 后旧 observer disconnect，新 DOM targets 重新 observe；
7. 点击刻度定位对应 user message；
8. 桌面 hover/focus 摘要有长度上限；
9. 移动端轮次提示默认隐藏，仅在用户真实滚动消息窗口时显示 `当前第 X 轮 · 已加载 N 轮`，不得显示伪造全局 `X / Y`；
10. 轮次提示透明度与上下浮动箭头一致，并靠近输入框上边沿；程序化 follow-latest / 轮询滚动不得触发，停止滚动约 6 秒后隐藏；
11. 抽屉只列已加载轮次，并保留“加载更早”入口；
12. `prefers-reduced-motion` 时不强制 smooth scroll；
13. keyboard focus 和 `aria-label` 可用；
14. 深色主题下轮次抽屉普通项、active、hover/focus 都使用深色 surface 和可读文字，且显式覆盖全局 primary button 配色，避免浅绿底 + 灰字低对比。

#### Step 3.2 — 实现

- 在 `index.html` 增加固定挂载点；
- 在 `app.js` 建立独立的 `loadedTurnModel()`，不要从 DOM 文本反解析业务状态；
- message DOM 增加稳定的消息 identity / turn index 属性；
- `syncTurnRail()` 每次 history DOM 重建后重新绑定 observer；
- session 切换、logout、disconnect view reset 时显式 `disconnect()` 旧 observer 和清理滚动 timer；
- mobile drawer 不复制完整消息正文，只显示受限摘要；
- 深色主题为 `.turn-dialog-list / .turn-dialog-item / .active / :hover / :focus-visible` 提供独立配色，不能继承全局深色 primary button 的浅绿背景。

#### Step 3.3 — 验证并提交

```bash
bun test tests/web-message-ui.test.ts tests/web-ui-races.test.ts
node --check src/web/public/app.js
git diff --check
```

提交：

```bash
git commit -m "feat(web): add loaded-turn navigation rail"
```

---

### Task 4: Composer Control Hub

**目标**: 重构视觉结构，不改变现有写入语义，并采用 Codex 原生单主按钮交互：有草稿优先显示发送；空草稿且 active 时显示停止形态。running 本身不能自动禁用发送；真正能否发送仍以现有 `sendEnabled`、连接状态和 `state.pending` 为准，真正能否停止则以 exact-turn interrupt capability 为准。

#### Step 4.1 — 先补失败测试

覆盖：

1. textarea 仍保持 1～3 行 resize 行为；
2. iPhone/移动软键盘 `keyboard-open` 行为无回归；
3. running 且输入为空时统一显示 `⏹ 中断` 形态；interrupt unavailable/unverified 时按钮 disabled，不能出现可点击假能力；
4. running 且存在草稿时统一切回 `↑ 发送`；如果现有 `sendEnabled=true`，不能仅因为 running 被错误禁用发送；
5. owned 首轮即使存在草稿，只要 `sendEnabled=false` 就显示发送形态但保持 disabled，不新增未经验证的 steer；
6. `state.pending` 时继续禁止重复提交；
7. `delivery_unknown` 的“结果待确认”不能被 session running 文案覆盖掉；
8. 等待 Telegram 审批、离线恢复、普通 idle 状态均正确显示；
9. 没有会话级 model/reasoning/permission metadata 时，不渲染伪造徽标。

#### Step 4.2 — 最小实现

- 保留 `resizeComposer()` 和 `syncViewport()` 核心逻辑；
- 把状态显示从当前单一 footer 组织为 control row，但继续复用 `operation-status` 的 delivery 语义；
- Phase A 不新增历史会话 model/reasoning/permission 推断；
- 主按钮不拆成 Send / Stop 双按钮；空草稿 + active 时显示 Stop 形态，capability unavailable 时保持 disabled；一旦出现草稿立即切换为 Send 形态。

#### Step 4.3 — 验证并提交

```bash
bun test tests/web-message-ui.test.ts tests/web-ui-races.test.ts
node --check src/web/public/app.js
git diff --check
```

提交：

```bash
git commit -m "refactor(web): modernize composer control hub"
```

---

### Task 5: Phase A 集成门禁

**目标**: Phase A 四项功能经过完整自动化质量门禁和真实浏览器 smoke 后，才进入 Phase B。

#### Step 5.1 — 完整自动化门禁

必须全部成功：

```bash
bun test
bun run typecheck
node --check src/web/public/app.js
bun run build
git diff --check
```

禁止 `2>/dev/null || true` 或其他吞错方式。

#### Step 5.2 — 真实页面 smoke

至少验证：

- 桌面宽度 > 760px：活动卡片、轮次轨、Composer、快捷胶囊；
- 手机 / 响应式 ≤ 760px：软键盘、移动轮次胶囊、抽屉、safe-area；
- 长会话加载更早历史后，轮次导航仍正确；
- 运行任务期间页面后台/前台切换，耗时不重置；
- 断网再恢复，活动卡片先显示 stale/reconnecting，再用服务器事实校准；
- 快捷胶囊仅填入，不自动发出请求。

#### Step 5.3 — 阶段提交策略

Task 1～4 已各自提交时，不再强制制造一个空的“Phase A milestone commit”。若 smoke 产生修复，则以实际修复内容提交；没有额外变更就只记录验证结果。

将验证结果写入 `docs/ai/2026-10-12-codex-layout-evolution-delivery.md`。

---

## 4. Phase B：Owned-turn Interrupt Contract Gate

### Task 6: 真实目标机中断契约 PoC

**目标**: 证明“Sea-Bridge 自己创建的首轮 turn，在创建它的同一个 AppServerSession 内可以被精确中断，并在中断后正确 unsubscribe / release ownership”。

**2026-10-12 Gate 结果：PASS。** 目标宿主现场重新取证为 Darwin 25.5.0 arm64；实际执行 CLI 是 `/Users/zhuhaijun/.bun/bin/codex`，版本 `codex-cli 0.147.0`，并确认 `/Applications/ChatGPT.app` 存在。现场结果覆盖下述 Step 6.2 / 6.3 的全部 PASS 条件，因此 Phase C 已获准实施。先前文档中的 0.160.0 仅是旧环境记录，不能代表本次真实 Gate 版本。

### Step 6.1 — 先做本地 protocol-shape 单测

复用 `tests/codex-app-server-client.test.ts` 现有 `MockProcess`，只验证我们期望的行为，不把它当成 contract 证明：

1. `turn/interrupt` 请求带 exact `threadId + turnId`；
2. RPC 接纳后 owning session 仍保持存活，直到 matching `turn/completed`；
3. matching terminal 后仍执行 `thread/unsubscribe`；
4. duplicate interrupt 不产生针对另一个 turn 的请求；
5. expected turn 不匹配时，本地逻辑在发 RPC 前拒绝。

### Step 6.2 — 目标 Mac 原始 PoC

使用目标机实际配置解析出的 bundled Codex CLI，建立**全新的测试 thread**，禁止选择现有用户工作中的 active thread。

PoC 要求：

1. 记录 CLI 绝对路径和 `codex --version`；
2. 使用与正式代码相同的 `initialize -> initialized` framing；
3. 新建 fresh test thread；
4. 使用 `read-only` / 无网络的安全 turn 权限，prompt 不要求文件修改；
5. `turn/start` 返回 exact `turnId` 后，**立即在同一个 `AppServerSession`** 调用 `turn/interrupt(threadId, turnId)`；
6. 捕获并记录 interrupt RPC response shape；
7. 捕获 matching `turn/completed`，确认 `params.threadId` 与 `params.turn.id` 精确匹配，并记录目标版本真实 terminal status 字段；
8. 调用 `thread/unsubscribe`，关闭 owning session；
9. 从第二个新 App Server session 对该 thread 做安全 resume/read 验证，确认没有残留 active writer；
10. 清理/归档测试 thread，或在交付记录中明确留下的测试 thread identity 供人工清理。

PoC 不使用 Web interrupt endpoint，不经过 `DesktopSameSessionAdapter`，也不触碰已有 Desktop/CLI active thread。

### Step 6.3 — Gate 判定

**PASS 必须同时满足**：

- 同 session interrupt 被目标版本接纳；
- terminal event 可精确绑定同一 turn；
- terminal status 可可靠识别 interrupted；
- unsubscribe/release 后没有 writer-held 残留；
- 不需要第二 writer 强行 takeover 才能完成中断。

任一条件失败：

- Phase C 不实施；
- UI 继续显示 interrupt unavailable；
- 在 `docs/ai/2026-10-12-codex-layout-evolution-delivery.md` 记录 exact failure 和版本；
- 不用 `thread/resume + turn/interrupt` 跨实例兜底。

### Step 6.4 — PoC 后质量检查

若 Phase B 为了可重复诊断新增脚本/测试，运行：

```bash
bun test tests/codex-app-server-client.test.ts
bun run typecheck
git diff --check
```

---

## 5. Phase C：Owned-turn Interrupt 正式接入（仅 Phase B PASS）

### Task 7: 中断所有权模型、后端端点与前端状态机

### Step 7.1 — 先把 ownership 单一事实源收进 Action Client

当前 `CodexWebSource` 自己维护的 `owners: Set<threadId>` 只能看到 Web 自己创建的首轮；同一个 `CodexAppServerClient` 也被 Telegram `NewThreadManager` 使用，因此它无法完整代表所有 Sea-Bridge-owned Action turns。

Phase C 应把 ownership 下沉到 `CodexAppServerClient`，建议状态：

```typescript
interface OwnedTurnState {
  threadId: string;
  turnId: string | null;
  state: "starting" | "running" | "interrupting";
}
```

要求：

- `thread/start` 得到 threadId 后即进入 `starting`，先阻止并发 queue send；
- `turn/start` 得到 turnId 后进入 `running`；
- interrupt 请求接纳后进入 `interrupting`；
- matching terminal + unsubscribe + session close 后才删除 owner；
- Web 和 Telegram 创建的 Action turn 使用同一个 owner registry；
- `CodexWebSource` 的 send gating 与 interrupt capability 均读取这个 registry，避免两套 owner 状态漂移。

先补 `tests/codex-app-server-client.test.ts` / `tests/web-codex-source.test.ts`：

1. Web-created owned turn；
2. 外部注入的 Telegram-created owned turn 同样阻止 Web follow-up queue；
3. non-owned Desktop/CLI thread 无 interrupt capability；
4. terminal release 后恢复 send eligibility；
5. owner 的 `turnId=null` 时可阻止 send，但不能提供 interrupt 按钮。

### Step 7.2 — 实现窄的 `interruptOwnedTurn()`

接口语义：

```typescript
interruptOwnedTurn({ threadId, expectedTurnId }): Promise<
  | { status: "interrupting" }
  | { status: "not_owned" }
  | { status: "turn_changed" }
  | { status: "already_finished" }
>
```

规则：

- 只查 owning registry；
- `expectedTurnId` 必须与 registry 中当前 turn 完全相同；
- mismatch 时不发 RPC；
- `interrupting` 状态重复请求可幂等返回 `interrupting`，不得再选择其他 turn；
- RPC 接纳不代表已终止；owner 直到 matching terminal 后才释放。

### Step 7.3 — WebSource 暴露精确 turn control

在 `src/web/sources/types.ts` 定义窄投影，例如：

```typescript
interface WebTurnControl {
  activeTurnId: string | null;
  interrupt:
    | { status: "available"; scope: "exact_codex_turn" }
    | { status: "interrupting"; scope: "exact_codex_turn" }
    | { status: "unavailable"; reason: "turn_unknown" | "provider_unavailable" | "provider_unverified" };
}
```

当前实现只在会话 detail/history 响应中返回完整 turn control，避免会话列表为了按钮能力增加额外协议负担。provider 身份只保留在后端，UI 不区分 owned / Desktop / CLI / queue。

测试：

- owned + exact turnId -> available；
- owned + turnId unknown -> unavailable/turn_unknown；
- running from hook/rollout but属于 non-owned external active writer -> unavailable/provider_unverified（目标 Mac Gate 已 FAIL）；
- 注入已验证 provider capability 后，non-owned exact active turn 可投影为 available；
- idle -> no actionable interrupt；
- capability 不受伪 `interrupted` ReadService 投影影响。

### Step 7.4 — HTTP endpoint

新增：

```http
POST /api/sessions/codex/:id/interrupt
Content-Type: application/json
X-Sea-Bridge-CSRF: ...

{ "expectedTurnId": "..." }
```

测试至少覆盖：

1. 未登录 401；
2. CSRF 失败 403；
3. `expectedTurnId` 缺失/过长/非法类型 400；
4. session 不存在 404；
5. external active-writer provider 已验证不可用时 409 `interrupt_provider_unverified`；
6. turn changed 409 `active_turn_changed`；
7. already finished 409 `interrupt_already_finished`；
8. provider unavailable 503 `interrupt_provider_unavailable`；
9. success -> `{ status: "interrupting" }`；
10. endpoint 记录不含 prompt/body 的安全 audit event（device + thread identity + outcome），不写工具内容或消息正文；旧 `interrupt_not_owned` 仅保留兼容映射，不再作为新的 capability 语义。

继续复用 `readAuthorizedJson()` 的 body 后登录态 / CSRF 二次校验。

### Step 7.5 — 前端 exact-turn 状态机

在 `tests/web-message-ui.test.ts` / `tests/web-ui-races.test.ts` 先补：

1. active 会话输入为空时显示 `⏹ 中断` 形态；只有 `turnControl.interrupt.status === "available"` 且存在 exact `activeTurnId` 时才可点击；
2. active 会话一旦存在非空草稿，主按钮立即切换为 `↑ 发送`，其 enabled 状态只由现有 `sendEnabled / paused / pending` 决定；
3. non-owned external running 输入为空时也显示 disabled `⏹ 中断`，避免布局因 provider 来源不同而跳变；有草稿时恢复现有 queue/send 语义；
4. owned 首轮存在草稿但 `sendEnabled=false` 时显示 disabled `↑ 发送`，不借 UI 改造引入未验证 steer；
5. 点击中断瞬间复制 `expectedTurnId`，请求期间按钮为 `正在中断…` 且 disabled；
6. HTTP `{status:"interrupting"}` 后不能立即把 session 改成 idle；
7. 必须等待下一次服务器 history/session terminal evidence 才恢复普通按钮；
8. 请求途中刷新到新 turn B 时，原请求仍携带 A，不能改发 B；
9. `active_turn_changed` 后只提示并刷新，不自动重试；
10. offline / reconnecting 时停止形态可保留，但中断不可点击。

### Step 7.6 — 全量自动化门禁

```bash
bun test
bun run typecheck
node --check src/web/public/app.js
bun run build
git diff --check
```

全部通过后提交实际功能变更，例如：

```bash
git commit -m "feat(web): add exact owned-turn interrupt control"
```

### Step 7.7 — 真实目标机最终验收

至少完成：

1. Web 新建长首轮，页面出现 owned-turn 中断；
2. 点击后真实停止同一 turn；
3. terminal 明确为 interrupted；
4. writer ownership 释放，Desktop 可接管；
5. Web 或 Telegram 新建的 Sea-Bridge-owned 首轮均不会被 Web follow-up queue 并发写入；
6. Desktop/CLI/queue 启动的普通 running turn 在空草稿时显示 disabled `⏹ 中断`，有草稿时切换为现有 `↑ 发送`；任何情况下都不暴露假的可用中断能力；
7. A 完成、B 开始后的 stale A 中断请求不会误停 B；
8. 双击/重复请求不会误停后续 turn；
9. 现有 provisional interrupted -> completed correction 回归通过；
10. Telegram `/new`、Web create/send、Desktop open、queue recovery 等既有路径无回归。

将 exact Codex 版本、真实 thread/turn 测试结果、验证命令与未完成项写入 delivery 文档。

---

## 6. Phase D：Session Metadata Contract（已实现）

### Task 8: 建立可追溯的会话 metadata 数据链路 — DONE

**实施结果**：在不猜测、不扩大敏感数据投影的前提下，历史/当前 Codex 会话 Composer 已可展示真实存在的 model、reasoning effort 和 execution policy；字段缺失时独立省略。

### Step 8.1 — Thread metadata 安全投影 — DONE

生产 Web 链路继续保持 `CodexReadService -> CodexCatalogStore -> CodexWebSource`，不重新把 Web 接回 native SQLite：

- App Server thread wire allowlist 增加 `model / reasoningEffort`，写入 Sea-Bridge 自有 catalog；
- `CodexThreadStore` 同步支持 native 可选列 `model / reasoning_effort / sandbox_policy / approval_mode`，仅用于兼容/诊断/契约验证；
- native schema 只探测内部固定 allowlist，不接受浏览器或运行时提供列名；
- 任意可选列缺失时基础 thread 读取仍正常；
- 数据库只读打开策略不变。

先补 tests：

1. 0 个 metadata 可选列；
2. 仅 model；
3. model + reasoning；
4. 全字段；
5. 运行时 schema 变化后 retry；
6. malformed/unknown values 归一化为 missing/unknown，不抛大范围 source failure。

### Step 8.2 — Hook live metadata 只存 allowlist — DONE

`SessionStateStore` 已扩展：

- 可保存 `model` 及必要的 observation timestamp；
- `permission_mode` 先作为独立原始枚举事实处理，只有完成语义 Contract Gate 后才允许映射为 Web `executionPolicy`；
- 严禁持久化 `prompt`、`tool_input`、reasoning、任意未知 hook 字段；
- duplicate/stale hook 继续沿用现有 freshness 规则，不能用过期 Hook 覆盖新 native snapshot。

### Step 8.3 — 新增 `SessionMetadataResolver` — DONE

已增加独立 resolver；内部语义为：

```typescript
interface ProvenancedField<T> {
  value: T;
  source: "action" | "hook" | "native_thread";
  scope: "turn" | "session";
  observedAt?: number;
}
```

resolver 规则：

1. Sea-Bridge owned active turn 的实际 Action 参数是该 turn 强事实；
2. fresh Hook model 可覆盖较旧 session model，用于 active turn；
3. native thread snapshot 提供持久 session metadata；
4. reasoningEffort 只从有明确语义的字段读取；
5. Hook `permission_mode` 未验证时不映射为 Full Access / sandbox；
6. 冲突且不能按 scope/freshness 可靠裁决时省略字段；
7. model catalog 只补 displayName，不参与事实选择。

### Step 8.4 — Web 契约与 Composer — DONE

`WebSession` / history detail 已增加：

```typescript
interface WebSessionMeta {
  model?: { id: string; displayName?: string };
  reasoningEffort?: string;
  executionPolicy?: {
    sandbox?: "danger_full_access" | "workspace_write" | "read_only" | "unknown";
    approval?: "never" | "on_request" | "unknown";
  };
}
```

前端规则：

- 每段独立显示；
- 不存在就不占位、不显示假的“默认/中/完全访问”；
- catalog 不可用时可显示真实 model id；
- 不展示 metadata provenance、数据库字段名或本地路径；
- model 展示位置直接使用下拉选择器：idle Codex 会话可切换；running / approval / reconnect 状态保留当前值但 disabled，并像停止按钮一样明确降低透明度、显示 not-allowed 与不可用原因，不再增加模型弹窗。

### Step 8.4.1 — 当前会话模型切换 — DONE

为满足 Codex 原生 Composer 的会话级模型选择语义，新增：

1. `CodexAppServerClient.updateThreadModel()`：`thread/resume -> thread/settings/update -> thread/read` 精确回读确认，最后 unsubscribe/release；
2. `CodexWebSource.updateModel()`：实时 model catalog allowlist + verified-idle 双门禁；
3. `POST /api/sessions/codex/:id/model`：auth/CSRF/body bounds、稳定错误和不含 model id 的安全审计；
4. Composer model 展示位置直接使用原生下拉选择器；idle 时加载实时模型目录并可直接切换，running / approval / reconnect 时同一控件 disabled，且 disabled 状态必须有与停止按钮一致的视觉弱化和 title/ARIA 原因；
5. active writer、running、approval、unknown-idle、offline 全部 fail closed，不尝试抢锁；
6. 成功后只更新该 thread 的持久 settings，不修改 Sea-Bridge/Codex 全局默认模型，也不把 model 伪装进 `codex queue`；
7. 成功和失败都统一在顶部消息区反馈；业务失败必须带“模型切换失败”前缀，网络失败进入 reconnect 时顶部连接消息也保留该上下文。

回归必须覆盖：目录外 model 拒绝、active writer 拒绝、readback mismatch 不报成功、CSRF、审计脱敏、inline selector、切换后的即时 metadata、成功/失败顶部消息，以及 running 时同一 selector disabled。

### Step 8.5 — Phase D 门禁 — PASS

至少运行：

```bash
bun test tests/codex-thread-store.test.ts tests/codex-hook-provider.test.ts tests/web-codex-source.test.ts tests/web-message-ui.test.ts
bun run typecheck
node --check src/web/public/app.js
bun run build
git diff --check
```

真实目标机补充核验仍建议在发布前/后执行，但不阻塞当前 fail-closed 实现：

- active Desktop / CLI / Sea-Bridge thread 的 model/reasoning 与 Codex UI 是否一致；
- Hook `permission_mode` 与 native policy 是否存在可证明映射。当前未证明，因此代码**不**把 `permission_mode` 映射为 Web execution policy；
- external session 的 sandbox/approval 没有可信事实时保持隐藏。

---

## 7. Phase E：Universal Codex Interrupt

### Task 9: Provider 化现有 owned interrupt — DONE

**实施结果**：已抽象 `InterruptProvider` / `InterruptRouter` 并包装现有 owned interrupt，不改变 v1.1.8 的 same-owning-session 行为。

新增：

```typescript
interface InterruptRequest {
  threadId: string;
  expectedTurnId: string;
}

interface InterruptProvider {
  id: "owned_app_server" | "external_codex";
  capability(input: InterruptRequest): Promise<...>;
  interrupt(input: InterruptRequest): Promise<...>;
}
```

`OwnedAppServerInterruptProvider` 只是包装现有 `CodexAppServerClient.interruptOwnedTurn()`；抽象后保持既有 duplicate、stale turn、terminal race 和 writer release 语义，并纳入当前 463 项全量回归。

### Task 10: External provider 真实 Contract Gate — VERIFIED / GATE FAILED (Active Writer Isolation Proven)

**目标**：证明 Desktop / CLI / queue active turn 能否通过官方 App Server 控制路径安全停止。

#### 2026-10-12 目标宿主实机验证结果与物理证据：
- **执行宿主**：Darwin MacBookProM5Nvy.local 25.5.0 arm64 (Apple Silicon M5 MacBook Pro)
- **CLI 路径与版本**：/Users/zhuhaijun/.bun/bin/codex (codex-cli 0.147.0)
- **关联 Desktop**：/Applications/ChatGPT.app / /Applications/Codex-X.app

#### 实测记录：
1. **环境拓扑**：独立主进程（如 Desktop 或其他 CLI 实例）通过私有 codex app-server --listen stdio:// 运行；系统默认并不存在全局共享 daemon（/Users/zhuhaijun/.codex/app-server-control/app-server-control.sock 不存在）。
2. **测试过程**：
   - Writer A 启动 thread 01a12ec2-66fe-7922-9789-ae4af0fa0cf4 并开启生成中的 turn 01a12ec2-686f-7fb0-ab1a-ffbe0feb8747；
   - 独立启动的 Writer B（模拟 Sea-Bridge 独立 App Server）尝试直发 turn/interrupt：
     - **返回硬错误**：{"code":-32600,"message":"thread not found: 01a12ec2-66fe-7922-9789-ae4af0fa0cf4"}
   - Writer B 尝试先执行 thread/resume 再中断：
     - **返回排他锁冲突**：{"code":-32600,"message":"thread 01a12ec2-66fe-7922-9789-ae4af0fa0cf4 already has an active writer"}
   - Writer B 尝试 turn/steer（携带 expectedTurnId）：
     - **同样返回**：{"code":-32600,"message":"thread not found: 01a12ec2-66fe-7922-9789-ae4af0fa0cf4"}
   - Writer B 仅能执行 thread/read 只读观察。

#### 验收与裁决结论：
- **Contract Gate 判定：FAIL**。证明在当前架构下，官方 codex app-server 严格实施单 writer 内存与会话隔离。第二个独立的 App Server 实例无法合法介入或中断外部进程持有的活跃 turn。
- **安全落地规范**：
  1. 坚决禁止跨实例强行 resume 或篡改外部会话；
  2. 坚决遵守红线第 12 条，严禁用 kill process、pkill、SIGINT 整个 Codex/Desktop 进程充当正常中断手段；
  3. 生产环境严格保持 **fail-closed**：未持有 owning session 的外部活跃 turn，统一返回 interrupt_provider_unverified，前端保持原有的排队/发送逻辑，绝不假中断或伪造成功。

上述 Gate 准则已经执行完毕。关键控制步骤在当前目标机上失败：独立 App Server 无法获得外部 active writer 的 thread 控制权，因此无需继续做生产 fallback，也不再把 external provider 作为当前版本待开发项。

后续只有在 Codex 上游新增共享控制总线、writer-safe attach/control 或等价官方 contract 时，才重新执行一轮新的 Gate；仍然明确禁止用 kill process、pkill、SIGINT 整个 Codex/Desktop 进程充当正常 turn interrupt provider。

### Task 11: `InterruptRouter` 与稳定 Web API — DONE / EXTERNAL PROVIDER DISABLED BY GATE

Router 核心、稳定 Web API 与 owned provider 已实施；当前生产 provider 集合只注册 `OwnedAppServerInterruptProvider`。本次 external Gate FAIL 后，不注册 production `ExternalCodexInterruptProvider`：

```text
POST /api/sessions/codex/:id/interrupt
{ expectedTurnId }
        │
        ▼
InterruptRouter
  ├─ exact owned match -> owned_app_server
  └─ non-owned external active turn -> provider_unverified (fail closed)
```

路由规则：

- 请求进入时固定 `threadId + expectedTurnId`；
- provider 一旦选中，本次请求不可切换 provider；
- 不允许 owned provider 失败后自动 fallback external，反之亦然；
- `active_turn_changed` 不自动重试；
- provider RPC success 仅表示 accepted，UI 继续等 terminal evidence；
- unsupported Codex version / uncertain writer state 必须 fail closed。

Web endpoint 路径、CSRF、auth、审计和前端按钮保持统一，不为 Desktop/CLI 新增第二套 endpoint/UI。

### Task 12: Phase E 验收 — DONE WITH VERIFIED EXTERNAL LIMITATION

当前验收结果：

1. Sea-Bridge Web owned turn 可中断；
2. Telegram created owned turn 可中断；
3. Desktop / CLI / queue 外部 active writer 的跨实例 App Server 控制 Gate 已实测 FAIL，因此明确不可中断；
4. non-owned external active turn 统一返回 `interrupt_provider_unverified`，前端不显示假中断能力；
5. 所有**已验证可控**来源都复用同一个 `⏹ 中断` Web API / UI，不暴露 provider 实现；
6. stale-turn、duplicate、terminal race、offline/reconnect 回归通过；
7. provider 不可用时 send/queue 原语义无回归；
8. `DesktopSameSessionAdapter.interrupt()` 继续保留 `UNAVAILABLE_DESKTOP_INTERRUPT`，这是当前 Gate 的明确结果；
9. 未注册 external provider，不存在跨实例 fallback、抢 writer 或 kill-process 降级；
10. 全量质量门禁通过。

---

## 8. Phase F：保留的可选增强

以下继续不与核心 correctness 混做：

- rollout 微观工具活动安全 projection；
- 用户显式开启的一键直发快捷 action；
- dsh interrupt（独立 Host contract）；
- background terminal cleanup 等运维优化。

其中微观活动仍必须固定枚举 + 参数脱敏；快捷胶囊默认继续“填入后确认”，不因 Phase D/E 改变。
