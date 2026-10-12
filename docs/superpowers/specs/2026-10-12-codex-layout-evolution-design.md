# Sea-Bridge 借鉴 Codex 原生布局体验升级设计文档

- **创建日期**: 2026-10-12
- **最后修订**: 2026-10-12
- **状态**: 已评审并修订（Revised / Ready for Implementation Planning）
- **目标组件**: Sea-Bridge 会话详情页、输入控制器、Codex Web Source、Codex Action Client

---

## 1. 背景与目标

Sea-Bridge 部署在本地 Mac 上，通过手机或其他浏览器远程查看、跟进和继续 Codex / dsh 会话。当前会话页已经具备：

- 最近会话与历史分页；
- Codex 运行态的粗粒度 `running / idle / unknown / waiting_external_approval`；
- Codex 活跃轮次 `startedAt` 与前端 1 秒本地计时；
- 3 秒一次的会话 / 历史刷新；
- 输入框 1～3 行自动扩展；
- 消息复制、回到最早 / 最新位置；
- 断线重连、顶部统一消息区、移动端软键盘适配；
- Web 新建 Codex 会话时的模型选择。

本次升级的核心目标，是让长任务等待、长会话定位和移动端连续操作更接近 Codex 原生体验，同时继续遵守 Sea-Bridge 已有的几个关键约束：

1. **任何运行状态都必须来自已验证证据，不能由前端猜测。**
2. **不能因为存在官方 `turn/interrupt` RPC，就推导出 Sea-Bridge 可以跨 App Server 实例中断 Desktop / CLI 正在执行的 turn。**
3. **不能把 rollout 中的 reasoning、工具参数、本地路径或任意事件正文直接暴露到 Web。**
4. **模型、推理档位、权限等信息只有在来源提供可靠契约时才展示；未知就隐藏或明确标记未知。**
5. **快捷操作不能让助手正文中的隐藏 payload 绕过用户对实际发送内容的感知。**

升级拆成四个体验模块：

1. **运行态活动卡片 (Live Activity Card)**：先提供可靠的耗时、状态和当前轮次；微观工具活动只有在建立安全投影后再启用。
2. **快捷操作胶囊 (Quick Action Pills)**：从助手回复中提取明确的可继续选项，第一阶段以“填入输入框”为默认行为，避免隐藏的一键执行语义。
3. **输入框控制台化 (Composer Hub)**：整合可靠的运行态与能力提示；中断按钮只在当前 turn 具备精确且可执行的 interrupt provider 时出现。
4. **已加载轮次导航轨 (Loaded Turn Rail)**：帮助长会话快速定位，但不伪造全局轮次数量。

---

## 2. 评审结论与关键修正

原始方案方向正确，但存在 5 个需要在编码前修正的问题。

### 2.1 `turn/interrupt` 不能直接作为 Desktop 同会话中断能力

现有 `CodexAppServerClient.startThreadAndTurn()` 会启动一个独立 App Server session，并在 Sea-Bridge 创建的首轮 turn 完成前持续持有 writer ownership；完成后执行 `thread/unsubscribe` 并关闭该 session。

Desktop、CLI 或 `codex queue` 启动的 turn 并不由这个 Action session 持有。过去的同会话设计已经明确：在没有现场证明的 provider contract 前，禁止启动第二个 App Server 对正在被其他实例执行的 thread 做 `thread/resume / turn/steer / turn/interrupt`。

因此本次只允许：

- **第一阶段**：尝试支持 Sea-Bridge 自己持有的首轮 Action turn，在**同一个 AppServerSession** 内发出 `turn/interrupt`；
- **Desktop / CLI / queue 发起的 turn**：继续视为 `interrupt unavailable`，直到单独完成 provider PoC 和 contract gate；
- 不修改 `DesktopSameSessionAdapter.interrupt()` 为“普遍可用”，也不把 Headless/Action interrupt 冒充 Desktop 同会话 interrupt。

### 2.2 当前 Web 数据契约不支持“正在读取某文件”等微观活动

当前 `readCodexTranscript()` 有意只向 Web 投影：

- 用户消息；
- `final_answer`；
- 粗粒度 lifecycle `task_started / task_complete / turn_aborted`；
- 可确认的轮次耗时。

工具调用、reasoning、命令参数和路径没有暴露。这是现有隐私边界的一部分。

因此第一阶段活动卡片只能展示可靠的粗粒度信息；若以后增加微观活动，必须单独设计 allowlist 投影，不允许直接把 rollout 行或工具参数传到浏览器。

### 2.3 “模型 / 推理档位 / 权限徽标”当前缺少现成会话级事实

当前 Web Source 的 `WebSession` 没有会话级 `model / reasoningEffort / sandbox / approvalPolicy`。模型目录只证明“可选择哪些模型”，不能证明一个历史会话当前正在使用哪个模型。

因此第一阶段不能硬编码类似 `agy/gemini-3.8-flash-medium · 中`，也不能把 Sea-Bridge 自身启动参数错误描述成 Desktop 当前会话权限。

### 2.4 一键直发助手生成的隐藏 prompt 风险过高

`- :codex-followup[显示文案]{prompt="隐藏指令"}` 允许“用户看到的标签”和“真正发送的 prompt”不同；再叠加启发式解析，容易将普通说明误识别成可执行操作。

考虑到 Codex 可能具备文件修改和命令执行能力，第一阶段快捷胶囊必须让用户看见实际发送内容，并默认先填入输入框。后续若需要真正单击直发，需增加明确的用户设置和更严格的 payload 等值约束。

### 2.5 当前历史读取不能证明全局 `第 X / Y 轮`

Web history 是分页、受限、证据保守的读取模型，`completeUserHistory` 当前为 `false`。因此移动端不能显示看似精确的全局 `第 X / Y 轮`。

轮次轨只针对**当前已加载且已执行的用户消息**建立索引；用户继续加载更早历史后，轨道随之扩展。

---

## 3. 总体架构与能力边界

本次保持现有 REST + SSE + 3 秒轮询架构，不为了视觉升级引入新的泛化事件总线。

```text
[ Web 前端 app.js / app.css ]
       │
       │ GET sessions/history     现有 3s poll
       │ POST messages            现有发送链路
       │ POST interrupt            仅 capability 允许时
       ▼
[ Web HTTP / CodexWebSource ]
       │
       ├── ReadService / rollout safe projection
       │      └── history + lifecycle + timing
       │
       ├── ProcessCodexQueueClient
       │      └── 非首轮续发
       │
       └── Codex Action Client
              └── Sea-Bridge 创建首轮的 owning AppServerSession
                    ├── turn/start
                    ├── turn/interrupt   (仅 owner turn，需 gate)
                    └── thread/unsubscribe
```

### 3.1 能力必须按会话、按 turn 暴露

建议给会话详情增加最小的运行能力投影，而不是用全局布尔值：

```typescript
interface WebTurnControl {
  activeTurnId: string | null;
  activeTurnStartedAt?: number;
  interrupt:
    | { status: "available"; scope: "sea_bridge_owned_turn" }
    | { status: "unavailable"; reason: "not_owned" | "turn_unknown" | "provider_unavailable" };
}
```

注意：

- `activeTurnId` 只有在来源能精确绑定当前 active turn 时才返回；
- `running` 不自动意味着 `interrupt.available`；
- `owners.has(threadId)` 只能证明 Sea-Bridge Action ownership，不能证明任意 Desktop turn 的控制权；
- 对 dsh 不复用 Codex 中断设计，除非 dsh Host 未来显式增加对应 contract。

---

## 4. 模块一：安全的运行态活动卡片

### 4.1 第一阶段展示内容

当当前会话有可靠 `running` 证据时，在消息流尾部挂载 `.live-activity-card`：

- 状态：`执行中` / `等待 Telegram 审批` / `正在中断` / `连接重连中`；
- 本轮耗时：基于服务器返回的绝对 `activeTurnStartedAt`，前端每秒本地计算；
- 当前 turn：仅在已有精确 `turnId` 时用于内部相关性，不在默认 UI 里展示完整 ID；
- 刷新时间：必要时用来表示状态新鲜度，不能把 stale 状态继续显示成实时运行。

示例：

```text
● 执行中 · 已运行 2 分 31 秒
正在处理当前轮次…
```

第一阶段**不展示**：

- `正在读取 xxx.md`；
- shell 命令；
- 工具调用参数；
- reasoning 文本；
- 任意本地绝对路径。

### 4.2 数据来源

第一阶段直接复用现有链路：

- `CodexWebSource.history()` 返回 `sessionState` 和 `activeTurnStartedAt`；
- 页面保留现有 3 秒 `refresh()`；
- 前端保留现有 1 秒 `renderSessionStatus()` 本地计时；
- 活动卡片与顶部 `execution-timer` 必须使用同一个时间事实，避免两个计时器漂移。

这意味着第一阶段无需为了活动卡片新增携带正文的 SSE 事件。

### 4.3 后续“微活动”扩展门槛

只有满足以下条件后，才能增加诸如“读取文件 / 修改文件 / 运行测试”的微活动：

1. 定义固定枚举，例如 `read_file / edit_file / run_test / web_search / waiting_approval`；
2. 默认不返回原始工具参数；
3. 文件只允许返回经过现有 redaction 规则处理的 basename，不能返回绝对路径；
4. 不能返回 reasoning；
5. 单条文本有长度上限；
6. 来源不认识的 event type 直接忽略，不能透传；
7. 有单测证明 Web API 不会泄露工具原始 payload。

在该 contract 建立前，“最近微观操作”属于后续能力，不作为本次第一阶段验收项。

### 4.4 完成态

收到可靠终态后：

- `completed / failed / interrupted` 由来源证据决定；
- 活动卡片淡出或变为最终状态后移除；
- 不写入聊天历史；
- 不因为独立 ReadService 短暂投影无证据 `interrupted` 就提前显示“已中断”，继续遵守现有 provisional-interrupted 规则。

---

## 5. 模块二：快捷操作胶囊

### 5.1 第一阶段只解析“可见文本选项”

不支持“显示文案”和“隐藏 prompt”分离。

允许两种来源：

1. **明确标记语法**，其中实际发送文本必须等于用户看到的文本；
2. **保守启发式**，只识别结构明确的短选项，例如：
   - `选项 1：继续修改代码`
   - `选项 2：只更新文档`
   - `回复「继续」执行下一步`

禁止仅凭关键词“一镜到底”“确认”“Worktree”就在普通段落里生成按钮。

### 5.2 安全交互

第一阶段行为：

1. 点击胶囊；
2. 将**按钮上可见的完整文本**写入输入框；
3. 输入框获得焦点；
4. 用户再点击现有发送按钮。

这样仍能明显减少移动端输入成本，同时保留最终发送动作的可见确认。

若以后增加“一键直发”设置，必须同时满足：

- 默认关闭；
- prompt 与按钮可见文本完全相同；
- 不接受隐藏属性覆盖 payload；
- 仍走现有 `submitWrite()`、operation UUID、幂等与 delivery-unknown reconciliation；
- 不能绕过来源审批或安全策略；
- `state.pending` 已存在时禁止再次发送。

### 5.3 DOM 与 Markdown 安全

当前 `renderMarkdown()` 使用 `textContent` 创建节点，应继续保持该模式。

快捷胶囊：

- 不能通过 `innerHTML` 注入；
- 最大数量建议 4 个；
- 单条最大显示 / payload 长度建议 120 字符；
- code block、blockquote、表格内容不参与启发式提取；
- 用户消息不解析快捷动作，只处理 assistant 最终回复。

---

## 6. 模块三：输入框控制台化

### 6.1 保留现有已验证行为

当前输入框已经实现 1～3 行自动扩展和移动端 keyboard-open 适配，本次不重写 textarea 高度逻辑，只重构视觉布局。

建议结构：

```text
┌─────────────────────────────────────┐
│ 输入消息…                           │
│                                     │
├─────────────────────────────────────┤
│ [运行态 / 能力提示]        [主按钮] │
└─────────────────────────────────────┘
```

### 6.2 左侧状态信息

按可靠程度依次展示：

- `执行中 · 2分31秒`；
- `等待 Telegram 审批`；
- `状态未知`；
- `排队中`；
- `结果待确认`。

现有 `operation-status` 继续承担“本次提交是否明确接纳”的语义，不能用 session running 覆盖 delivery-unknown。

### 6.3 模型、推理档位、权限

第一阶段：

- **不在已有会话 Composer 中显示模型和推理档位**，除非后端新增可信会话级 metadata；
- 新建会话弹窗继续展示模型选择；
- 不显示笼统的 `🛡️ 完全访问`，因为这可能把 Sea-Bridge Action 配置误解为 Desktop 当前会话权限。

后续若增加 `sessionMeta`，建议结构为：

```typescript
interface WebSessionMeta {
  model?: { id: string; displayName: string };
  reasoningEffort?: string;
  executionPolicy?: {
    sandbox: "danger_full_access" | "workspace_write" | "read_only" | "unknown";
    approval: "never" | "on_request" | "unknown";
    scope: "this_turn" | "this_session";
  };
}
```

UI 只能展示实际存在的字段，不能从 model catalog 或本机默认配置反推历史会话事实。

### 6.4 主按钮状态机

#### Idle

- 输入为空：发送按钮 disabled；
- 输入有内容且 source 允许发送：`↑ 发送`。

#### Running + interrupt unavailable

- 保持输入能力是否可用由现有 source `sendEnabled` 决定；
- 主按钮不能伪装成 `中断`；
- 可显示灰色状态提示 `当前任务运行中 · 暂不支持远程中断`。

#### Running + exact interrupt available

- 主按钮显示 `⏹ 中断`；
- 点击时捕获当前**精确 `turnId`**；
- 进入 `interrupting` 状态后按钮 disabled；
- 只有观察到该 turn 的真实终态后才切回 Idle。

---

## 7. 模块四：已加载轮次导航轨

### 7.1 轮次定义

一个导航刻度对应当前 DOM 中一个**已经进入执行历史的 user message**。

不计入：

- `deliveryState=queued` 的待执行消息；
- 系统注入 envelope；
- assistant 消息；
- 尚未加载的更早历史。

### 7.2 桌面端

视口 `> 760px`：

- 在消息区域左侧显示 `.turn-rail`；
- 每个已加载 user message 一个 `.turn-tick`；
- `IntersectionObserver.root` 必须设为 `#messages`，不能默认观察 window；
- 当前阅读轮次按最接近消息容器上方阅读锚点的 user message 高亮；
- 点击刻度调用 `scrollIntoView({ block: "start" })`；
- hover / focus 显示经过长度限制的用户问题摘要。

当前 `loadHistory()` 会在内容变化时 `replaceChildren()`，因此重渲染后需要重新绑定 observer；不能长期保存已脱离 DOM 的 target。

### 7.3 移动端

视口 `≤ 760px`：

- 不占用横向正文宽度；
- 滚动期间在右下角显示 `已加载第 X 轮` 或 `当前第 X 轮 · 已加载 N 轮`；
- 不能显示伪造的全局 `X / Y`；
- 停止滚动约 2 秒后渐隐；
- 点击打开已加载轮次抽屉；
- 抽屉顶部提供现有“加载更早”能力，用户加载历史后列表实时扩展。

### 7.4 可访问性

- 刻度必须可键盘 focus；
- 使用 `aria-label="跳到已加载第 N 轮：摘要"`；
- `prefers-reduced-motion: reduce` 时关闭平滑滚动与不必要动画；
- 不仅依赖颜色表达当前轮次。

---

## 8. 中断能力详细设计

### 8.1 先做 contract gate

在实现 Web 按钮前，必须先用当前目标机 Codex 版本证明：

1. Sea-Bridge `startThreadAndTurn()` 的 owning `AppServerSession` 在 turn 活跃期间可以并发调用 `turn/interrupt`；
2. RPC 参数是精确 `threadId + turnId`；
3. 中断后同一 session 收到与该 `turnId` 对应的 `turn/completed`；
4. 状态可可靠区分 `interrupted`、自然 `completed`、already completed / too late；
5. 中断完成后仍执行一次 `thread/unsubscribe`，writer ownership 正常释放；
6. Desktop 随后能重新打开该 thread，不出现残留 writer；
7. 连续点击 / 网络重复请求不会误中断后续新 turn。

PoC 失败则本次 UI 保持 interrupt unavailable，不用第二个 App Server 兜底。

### 8.2 Action Client 内部所有权表

若 gate 通过，`CodexAppServerClient` 内部维护 owner turn，而不是只保存 `Set<threadId>`：

```typescript
interface OwnedTurn {
  threadId: string;
  turnId: string;
  session: AppServerSession;
  state: "running" | "interrupting";
}
```

外部不直接拿 `AppServerSession`。

新增窄方法：

```typescript
interruptOwnedTurn(params: {
  threadId: string;
  expectedTurnId: string;
}): Promise<
  | { status: "interrupting" }
  | { status: "not_owned" }
  | { status: "turn_changed" }
  | { status: "already_finished" }
>
```

关键规则：

- 只在 owner map 中查找；
- 必须匹配 `expectedTurnId`；
- 不允许在请求到达时“重新找一个新的 active turn 再停掉”；
- RPC response 只表示 interrupt 请求被接纳，不等价于最终中断成功；
- 最终状态仍以同 turn terminal evidence 为准。

### 8.3 HTTP 端点

```http
POST /api/sessions/codex/:id/interrupt
Content-Type: application/json
X-Sea-Bridge-CSRF: ...

{
  "expectedTurnId": "..."
}
```

沿用现有：

- 登录认证；
- same-origin / HTTPS 策略；
- CSRF；
- 请求体大小限制；
- 登录态异步二次校验。

建议响应：

```json
{ "status": "interrupting" }
```

稳定错误：

- `404 session_missing`
- `409 interrupt_not_owned`
- `409 active_turn_changed`
- `409 interrupt_already_finished`
- `503 interrupt_provider_unavailable`

如果前端刷新后已经确认会话 idle，可直接隐藏按钮，不必发请求。

### 8.4 竞态规则

用户意图绑定“点击按钮那一刻的 turn”。

若发生：

```text
T0 UI 显示 turn A
T1 turn A 自然完成
T2 turn B 开始
T3 中断请求到达后端
```

后端必须返回 `active_turn_changed / not_owned`，绝不能自动把目标切换到 turn B。

### 8.5 与 provisional interrupted 的兼容

现有 observer 已经处理独立 ReadService 对运行中 turn 短暂误投影 `interrupted` 的问题。本功能不能破坏该规则。

只有以下证据之一成立时，Web / Telegram 才能把目标 turn 确认为真实 interrupted：

- 官方终态带可信 completion evidence；
- 精确 Interrupt Hook 对应同一个 turn；
- owning Action session 收到同 turn 的正式 terminal 通知并满足现有 contract。

---

## 9. 断网、刷新与状态恢复

### 9.1 断网

SSE / HTTP 失联后：

- 活动卡片显示 `连接重连中`；
- 本地耗时可以继续增长，但必须明确属于“最后已知运行状态”；
- 不允许在离线时点击中断；
- 快捷胶囊可以填入输入框，但发送按钮保持现有离线禁用策略；
- 轮次轨继续针对已加载消息可用。

### 9.2 重连

恢复流程继续遵守当前策略：

1. 重新确认登录；
2. 重新加载 settings / redaction；
3. SSE 恢复；
4. 重新 GET 当前 session/history；
5. 用服务器最新事实校准 running / idle / approval / active turn；
6. 不把离线期间的本地计时或旧 active turn 当作新的控制依据。

### 9.3 页面刷新

控制状态不依赖浏览器 LocalStorage 持久化 active turn。刷新后重新从来源取证。

---

## 10. 实施顺序

建议分 4 个小阶段，避免一次把 UI 与执行控制绑死。

### Phase A：纯 UI / 已有数据

- 活动卡片：running + elapsed + approval / reconnect；
- Composer 视觉重构，复用现有 textarea resize；
- 已加载轮次轨；
- 快捷胶囊“填入输入框”；
- 不新增 interrupt。

### Phase B：Owned-turn interrupt PoC

- 为目标 Codex 版本补 fixture / integration PoC；
- 证明同 owning AppServerSession 的 `turn/interrupt`；
- 证明 unsubscribe / owner release 正常；
- 失败则停止，不做跨实例 fallback。

### Phase C：Owned-turn interrupt 正式接入

- owner map；
- `interruptOwnedTurn()`；
- WebSource capability；
- HTTP endpoint；
- 前端精确 turn 中断状态机。

### Phase D：可选增强

- 安全微活动 projection；
- 会话级 model / reasoning / execution policy metadata；
- 用户显式开启的一键直发快捷操作；
- Desktop/CLI active interrupt provider（仅在独立 contract gate 通过后）。

---

## 11. 测试与验收标准

### 11.1 活动卡片

1. `running + activeTurnStartedAt` 时出现活动卡片，耗时每秒增长；
2. 页面 background / foreground 后计时从绝对时间恢复，不从 0 重新计；
3. `idle` 时卡片消失；
4. 等待 Telegram 审批时显示审批状态；
5. 断网显示重连状态，不能把 stale running 当成新的控制事实；
6. 无任何工具参数、reasoning、绝对路径泄露到 Web 响应。

### 11.2 快捷胶囊

1. 明确选项可生成胶囊；
2. 普通段落中的关键词不会误生成；
3. code block / table / quote 不触发启发式操作；
4. 点击只填入输入框，实际文本与用户看到的一致；
5. 最多 4 个、长度受限；
6. DOM 仍使用 text nodes，不产生 HTML 注入。

### 11.3 Composer

1. 现有 1～3 行自动扩展无回归；
2. iPhone 软键盘弹出时 header/nav 行为无回归；
3. 未知模型 / reasoning / 权限不会显示伪造值；
4. running 但 interrupt unavailable 时不显示可点击中断按钮；
5. operation `delivery_unknown` 仍保留“结果待确认”，不会被 running 状态掩盖。

### 11.4 轮次轨

1. 桌面只为已加载 executed user messages 建刻度；
2. 加载更早历史后刻度增加；
3. `replaceChildren()` 后 observer 重新绑定；
4. 点击刻度跳到对应消息；
5. 移动端只显示“已加载轮次”，不伪造全局总数；
6. reduced-motion 与键盘操作可用。

### 11.5 Owned-turn interrupt（只有 Phase B gate 通过才验收）

1. Sea-Bridge 新建长首轮时出现中断按钮；
2. 点击后请求携带点击时的 `expectedTurnId`；
3. 同一 owning AppServerSession 执行 `turn/interrupt`；
4. RPC 接纳后 UI 保持 `正在中断…`，直到 terminal evidence 到来；
5. 真正 interrupted 后释放 writer，Desktop 可正常接管；
6. turn 已完成时不误停后续 turn；
7. 双击 / 重复请求幂等，不中断新的 turn；
8. Desktop / CLI / queue 启动的非 owned turn 不显示可用中断按钮；
9. 不通过第二 App Server 强行 resume/interrupt 非 owned thread；
10. 现有 provisional interrupted → completed correction 逻辑无回归。

---

## 12. 预期修改范围

Phase A 预计主要修改：

- `src/web/public/index.html`
- `src/web/public/app.css`
- `src/web/public/app.js`
- 必要时小幅扩展 `src/web/sources/types.ts`
- 对应 Web 前端 / source tests

Phase B / C 若 contract gate 通过，预计修改：

- `src/desktop/codex-app-server-client.ts`
- `src/web/sources/codex.ts`
- `src/web/sources/types.ts`
- `src/web/http.ts`
- `src/web/public/app.js`
- `src/web/public/app.css`
- `tests/codex-app-server-client.test.ts`
- `tests/web-codex-source.test.ts`
- Web HTTP / frontend 相关测试

本设计**不要求**把 `src/desktop/same-session-adapter.ts` 的 `UNAVAILABLE_DESKTOP_INTERRUPT` 直接改成可用。只有未来证明真正的 Desktop 同会话主动 interrupt provider 后，再单独修改该 capability。

---

## 13. 最终设计裁决

本次布局升级可以实施，但需要把“视觉上像 Codex”和“控制能力真的等价于 Codex Desktop”严格分开。

第一阶段优先交付低风险、高收益的体验升级：**活动耗时、Composer 重构、快捷填入、已加载轮次导航**。中断功能只针对 Sea-Bridge 自己持有并能精确绑定的 Action turn，在同一个 AppServerSession contract 被真实证明后开放。

微观工具活动、历史会话模型/推理档位、Desktop/CLI 主动中断都属于需要独立数据契约或 provider 取证的增强项。在取证完成前隐藏能力，比展示一个看似完整但语义错误的 UI 更可靠。
