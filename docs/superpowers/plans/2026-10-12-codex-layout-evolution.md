# Sea-Bridge 借鉴 Codex 原生布局体验升级实施计划 (Implementation Plan)

- **Goal**: 将 Sea-Bridge 会话详情与控制体验向 Codex 原生布局对齐，实现“安全运行态活动卡片、已加载轮次指示轨、输入框控制台化与安全快捷选项填入（Phase A）”，并为拥有者轮次中断构建可重复、可取证的目标机 Contract Gate 与正式接入链路（Phase B/C）。
- **Architecture**: 保留 Sea-Bridge 现有 REST + SSE + 3 秒轮询数据链路。前端基于已有安全 DOM 渲染模型（`textContent`）构建活动卡片、快捷选项和轮次导航；中断能力严格限定为 Sea-Bridge 当前 `CodexAppServerClient` **同一个 owning AppServerSession** 正在持有的精确 turn，不跨实例 resume/interrupt Desktop、CLI 或 queue-owned turn。
- **Tech Stack**: TypeScript, Bun test, 原生 Web API (DOM, CSS, IntersectionObserver), Node/Bun child_process 与 JSON-RPC。
- **Reference Spec**: [docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md](/opt/app/aitools/sea-bridge/docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md:1)
- **Plan Status**: 2026-10-12 review revised；Phase A 已实现，Phase B 真实目标机 Contract Gate 已通过，Phase C exact owned-turn interrupt 已实现。

### 2026-10-12 实施状态

- **Phase A 已实现**：安全活动卡片、可见选项快捷填入、已加载轮次导航、Composer 控制台化均已落地，并补充 UI / 安全 / 竞态回归测试。
- **共享 ownership 已收口**：`CodexAppServerClient` 维护 `starting / running / interrupting` 的 exact owning turn，并保留 owning `AppServerSession`；`CodexWebSource` 读取同一事实源，因此 Web 与 Telegram 创建的 Action 首轮在 writer 释放前都不会被 Web 错误开放续发。
- **Phase B 真实 Contract Gate 已通过**：目标宿主为 Darwin 25.5.0 arm64，真实验证使用 `/Users/zhuhaijun/.bun/bin/codex`（`codex-cli 0.147.0`）。同一 owning App Server session 对 exact active turn 调用 `turn/interrupt` 被接纳，随后同一通信流收到官方 `turn/completed(status=interrupted)` 且带 completion evidence；`thread/unsubscribe` 成功后，新建的第二个 App Server session 能 `thread/resume` 同一测试 thread 并启动下一 turn，证明 writer ownership 已释放。
- **Phase C 已实现**：新增 exact owned-turn `interruptOwnedTurn()`、Web `turnControl` 投影、CSRF 保护的 interrupt endpoint、安全审计和前端 `⏹ 中断 / 正在中断…` 状态机。所有请求绑定点击瞬间的 `expectedTurnId`，不自动改停后续新 turn。
- **边界保持不变**：`DesktopSameSessionAdapter.interrupt()` 仍保持 unavailable；Desktop / CLI / `codex queue` 发起的非 owned turn 仍不允许通过第二 App Server 跨实例 resume/interrupt。
- 当前自动化回归：`bun test` **451 pass / 0 fail**、**2062 expectations**；最终静态门禁见本次实施验收记录。

---

## 1. 实施原则与禁止事项

1. **状态只来自已验证证据**：`running / idle / waiting_external_approval / activeTurnStartedAt / activeTurnId` 均不能由 UI 猜测。
2. **running 不等于 interruptable**：只有后端明确返回 exact owned-turn interrupt capability 时，Web 才出现可点击中断按钮。
3. **中断意图绑定点击瞬间的 `expectedTurnId`**：请求到达后不得重新寻找“当前新 turn”并停止它。
4. **不扩大 rollout Web 投影**：Phase A 不返回 reasoning、tool arguments、shell command、本地绝对路径或原始工具事件。
5. **快捷操作没有隐藏 payload**：按钮可见文本就是写入输入框的文本；不支持 `{prompt="隐藏指令"}` 覆盖。
6. **不伪造历史完整度**：轮次导航只表达“当前已加载并已执行的 user turns”，不显示假的全局 `X / Y`。
7. **不吞质量门禁失败**：测试、typecheck、build、JS syntax、`git diff --check` 任一失败均为阻断，不允许 `|| true`。
8. **Phase B mock 不能替代真实 contract gate**：单元测试只能证明 Sea-Bridge 自己的逻辑，真正的 `turn/interrupt` 支持必须在目标 Mac 当前 bundled Codex 上实测。

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
  - 不将 Desktop/CLI/queue running turn 标记为 interruptable。
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

---

## 3. Phase A：纯 UI / 已有安全数据

### Task 1: 运行态安全活动卡片

**目标**: 对当前选中会话显示可靠的运行态、审批态和断线态；只有存在 `activeTurnStartedAt` 时才显示耗时。活动卡片不进入历史持久化，也不依据最终回答文本自行猜测 turn 已结束。

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
9. 移动端显示 `当前第 X 轮 · 已加载 N 轮`，不得显示伪造全局 `X / Y`；
10. 移动端停止滚动约 2 秒后隐藏；
11. 抽屉只列已加载轮次，并保留“加载更早”入口；
12. `prefers-reduced-motion` 时不强制 smooth scroll；
13. keyboard focus 和 `aria-label` 可用。

#### Step 3.2 — 实现

- 在 `index.html` 增加固定挂载点；
- 在 `app.js` 建立独立的 `loadedTurnModel()`，不要从 DOM 文本反解析业务状态；
- message DOM 增加稳定的消息 identity / turn index 属性；
- `syncTurnRail()` 每次 history DOM 重建后重新绑定 observer；
- session 切换、logout、disconnect view reset 时显式 `disconnect()` 旧 observer 和清理滚动 timer；
- mobile drawer 不复制完整消息正文，只显示受限摘要。

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

**目标**: 重构视觉结构，不改变现有写入语义。running 本身不能自动禁用发送，也不能自动把按钮变为中断；真正能否发送仍以现有 `sendEnabled`、连接状态和 `state.pending` 为准。

#### Step 4.1 — 先补失败测试

覆盖：

1. textarea 仍保持 1～3 行 resize 行为；
2. iPhone/移动软键盘 `keyboard-open` 行为无回归；
3. running 且 interrupt unavailable 时不出现可点击“中断”；
4. running 会话如果现有 `sendEnabled=true`，不能仅因为 running 被错误禁用发送；
5. `state.pending` 时继续禁止重复提交；
6. `delivery_unknown` 的“结果待确认”不能被 session running 文案覆盖掉；
7. 等待 Telegram 审批、离线恢复、普通 idle 状态均正确显示；
8. 没有会话级 model/reasoning/permission metadata 时，不渲染伪造徽标。

#### Step 4.2 — 最小实现

- 保留 `resizeComposer()` 和 `syncViewport()` 核心逻辑；
- 把状态显示从当前单一 footer 组织为 control row，但继续复用 `operation-status` 的 delivery 语义；
- Phase A 不新增历史会话 model/reasoning/permission 推断；
- 中断按钮槽位可以预留 DOM/style，但 capability unavailable 时不显示可点击动作。

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
    | { status: "available"; scope: "sea_bridge_owned_turn" }
    | { status: "unavailable"; reason: "not_owned" | "turn_unknown" | "provider_unavailable" };
}
```

建议只在会话 detail/history 响应中返回完整 turn control，避免会话列表为了按钮能力增加额外协议负担。

测试：

- owned + exact turnId -> available；
- owned + turnId unknown -> unavailable/turn_unknown；
- running from hook/rollout but non-owned -> unavailable/not_owned；
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
5. non-owned 409 `interrupt_not_owned`；
6. turn changed 409 `active_turn_changed`；
7. already finished 409 `interrupt_already_finished`；
8. provider unavailable 503 `interrupt_provider_unavailable`；
9. success -> `{ status: "interrupting" }`；
10. endpoint 记录不含 prompt/body 的安全 audit event（device + thread identity + outcome），不写工具内容或消息正文。

继续复用 `readAuthorizedJson()` 的 body 后登录态 / CSRF 二次校验。

### Step 7.5 — 前端 exact-turn 状态机

在 `tests/web-message-ui.test.ts` / `tests/web-ui-races.test.ts` 先补：

1. 只有 `turnControl.interrupt.status === "available"` 且存在 exact `activeTurnId` 才显示 `⏹ 中断`；
2. 点击瞬间复制 `expectedTurnId`，请求期间按钮为 `正在中断…` 且 disabled；
3. HTTP `{status:"interrupting"}` 后不能立即把 session 改成 idle；
4. 必须等待下一次服务器 history/session terminal evidence 才恢复普通按钮；
5. 请求途中刷新到新 turn B 时，原请求仍携带 A，不能改发 B；
6. `active_turn_changed` 后只提示并刷新，不自动重试；
7. offline / reconnecting 时中断不可点击；
8. running + non-owned 时继续使用普通 sendEnabled 语义，不显示假中断按钮。

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
6. Desktop/CLI/queue 启动的普通 running turn 不显示可用中断；
7. A 完成、B 开始后的 stale A 中断请求不会误停 B；
8. 双击/重复请求不会误停后续 turn；
9. 现有 provisional interrupted -> completed correction 回归通过；
10. Telegram `/new`、Web create/send、Desktop open、queue recovery 等既有路径无回归。

将 exact Codex 版本、真实 thread/turn 测试结果、验证命令与未完成项写入 delivery 文档。

---

## 6. Phase D：明确延期能力

以下不混入 Phase A-C：

- rollout 微观工具活动安全 projection；
- 历史会话 model / reasoningEffort / execution policy metadata；
- 用户显式开启的一键直发快捷 action；
- Desktop/CLI active-turn interrupt provider；
- dsh interrupt；
- background terminal cleanup。

它们分别需要独立的数据 contract 或 provider gate，不能通过本轮 UI 推断获得。
