# Sea-Bridge 借鉴 Codex 原生布局体验升级设计文档

- **创建日期**: 2026-10-12
- **最后修订**: 2026-10-12
- **状态**: Phase A-D 已实现；Phase E provider/router 与 owned provider 已实现，目标 Mac external provider Contract Gate 已完成并判定 FAIL，Desktop / CLI / queue external active-writer interrupt 当前保持 fail-closed
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
2. **产品最终目标是所有具备精确 active-turn 证据的 Codex running 会话都可中断；但任何具体 interrupt provider 都必须先通过对应 writer/版本 Contract Gate，不能仅因存在官方 `turn/interrupt` RPC 就假设跨实例安全。**
3. **不能把 rollout 中的 reasoning、工具参数、本地路径或任意事件正文直接暴露到 Web。**
4. **模型、推理档位、权限等信息必须来自逐字段可追溯的会话级事实；现已建立正式 Session Metadata Contract，未知字段继续隐藏，不从默认配置推断。**
5. **快捷操作不能让助手正文中的隐藏 payload 绕过用户对实际发送内容的感知。**

升级拆成四个体验模块：

1. **运行态活动卡片 (Live Activity Card)**：先提供可靠的耗时、状态和当前轮次；微观工具活动只有在建立安全投影后再启用。
2. **快捷操作胶囊 (Quick Action Pills)**：从助手回复中提取明确的可继续选项，第一阶段以“填入输入框”为默认行为，避免隐藏的一键执行语义。
3. **输入框控制台化 (Composer Hub)**：整合可靠的运行态与能力提示；主按钮复用 Codex 原生单按钮交互——有草稿时显示发送，空草稿且任务 active 时显示停止形态；只有当前 turn 具备精确且可执行的 interrupt provider 时停止按钮才可点击。
4. **已加载轮次导航轨 (Loaded Turn Rail)**：帮助长会话快速定位，但不伪造全局轮次数量。

---

## 2. 评审结论与关键修正

原始方案方向正确，但存在 5 个需要在编码前修正的问题。

### 2.1 中断能力必须 Provider 化，不能把当前 owning-session 实现当成最终产品边界

现有 `CodexAppServerClient.startThreadAndTurn()` 会启动一个独立 App Server session，并在 Sea-Bridge 创建的首轮 turn 完成前持续持有 writer ownership；完成后执行 `thread/unsubscribe` 并关闭该 session。Phase B 已在真实目标机证明：**同一个 owning `AppServerSession`** 可以对 exact active turn 安全调用 `turn/interrupt`，因此 v1.1.8 已具备第一种可靠 provider。

但产品目标不应停留在“只有 Sea-Bridge 创建的首轮能停止”。Desktop、CLI 或 `codex queue` 启动的 turn 也应在满足 exact active-turn 与 provider contract 后提供同一停止体验。

最佳实践是引入统一 `InterruptProvider` 层：

- `OwnedAppServerInterruptProvider`：v1.1.8 已实现，复用原 owning session；
- `ExternalCodexInterruptProvider`：目标 Mac / `codex-cli 0.147.0` 已完成真实 Contract Gate，跨实例 `turn/interrupt` / `turn/steer` 返回 `thread not found`，`thread/resume` 返回 `already has an active writer`；Gate 已判定 **FAIL**，因此当前不实现、不注册该 provider；
- Web 不关心 provider 类型，只消费按会话/turn 投影出的 capability；
- 任一 provider 都必须绑定点击瞬间的 `expectedTurnId`，不得在请求到达后重新选择“当前 active turn”；
- `DesktopSameSessionAdapter.interrupt()` 继续保持 unavailable，不能用第二 App Server 猜测性 takeover；只有未来 Codex 官方新增共享控制总线、writer-safe attach/control 等新契约后，才重新执行 Contract Gate。

因此，“Desktop / CLI / queue 外部 active writer 当前不可跨实例中断”已经是 **当前目标宿主与 Codex 0.147.0 的实测架构边界**，不是待补代码。未来若上游控制契约变化，应重新 Gate，而不是复用本次失败路径。

### 2.2 当前 Web 数据契约不支持“正在读取某文件”等微观活动

当前 `readCodexTranscript()` 有意只向 Web 投影：

- 用户消息；
- `final_answer`；
- 粗粒度 lifecycle `task_started / task_complete / turn_aborted`；
- 可确认的轮次耗时。

工具调用、reasoning、命令参数和路径没有暴露。这是现有隐私边界的一部分。

因此第一阶段活动卡片只能展示可靠的粗粒度信息；若以后增加微观活动，必须单独设计 allowlist 投影，不允许直接把 rollout 行或工具参数传到浏览器。

### 2.3 “模型 / 推理档位 / 权限徽标”已经建立正式 Session Metadata Contract

v1.1.8 的 `WebSession` 尚未投影会话级 `model / reasoningEffort / sandbox / approvalPolicy`；Phase D 已补齐 `WebSessionMeta` 与后端 resolver。原先 Phase A 的保守决定仍然正确：模型目录只证明“可选择哪些模型”，不能证明一个历史会话当前正在使用哪个模型。

但已有证据表明真实数据来源并非不存在：

- Codex Hook envelope 已包含 `model`、`permission_mode`；
- 已取证的 native `threads` schema 出现过 `model`、`reasoning_effort`、`sandbox_policy`、`approval_mode`；
- Sea-Bridge 自己创建的 Action thread 还知道实际 `thread/start` / `turn/start` 参数。

当前实现已经建立正式 `WebSessionMeta` 聚合契约，并坚持不从默认配置或 model catalog 猜测：

1. 每个字段独立取证、独立缺省，禁止“部分字段可读就整组补默认值”；
2. active turn 的实时事实优先于较旧的 thread snapshot，但必须保留 evidence/freshness 语义；
3. native schema 使用固定 allowlist projection + schema capability probing，不接受浏览器提供列名；
4. Hook 的 `permission_mode` 不能未经验证直接等价映射成 `sandbox_policy + approval_mode`；若语义未证明，应保留为独立事实或不展示；
5. catalog 只用于把真实 model id 映射成人类可读名称，catalog 不可用时可显示真实 id，但不能改变事实值。

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
       │ POST interrupt           统一 exact-turn API
       ▼
[ Web HTTP / CodexWebSource ]
       │
       ├── SessionMetadataResolver
       │      ├── App Server thread catalog (model / reasoningEffort)
       │      ├── fresh Hook allowlist metadata
       │      └── exact owned Action parameters
       │
       ├── ReadService / rollout safe projection
       │      └── history + lifecycle + timing
       │
       ├── ProcessCodexQueueClient
       │      └── 非首轮续发
       │
       └── InterruptRouter
              ├── OwnedAppServerInterruptProvider      ✅ v1.1.8
              │      └── owning AppServerSession -> turn/interrupt
              └── ExternalCodexInterruptProvider      ⛔ Gate FAIL / not registered
                     └── Desktop / CLI / queue active writer isolated in codex-cli 0.147.0
```

这里有两个重要架构原则：

1. **Web API 稳定，provider 可演进**：前端永远发送 `threadId + expectedTurnId`，不直接选择“owned / desktop / cli”实现；provider 选择由后端基于证据完成。
2. **Metadata 与控制解耦**：能读取模型/权限不代表能控制该 turn；能识别 running 也不代表 interrupt provider 已可用。每项 capability 独立取证。

### 3.1 能力必须按会话、按 turn 暴露

建议给会话详情增加最小的运行能力投影，而不是用全局布尔值：

```typescript
interface WebTurnControl {
  activeTurnId: string | null;
  activeTurnStartedAt?: number;
  interrupt:
    | { status: "available"; scope: "exact_codex_turn" }
    | { status: "interrupting"; scope: "exact_codex_turn" }
    | { status: "unavailable"; reason: "turn_unknown" | "provider_unavailable" | "provider_unverified" };
}
```

注意：

- `activeTurnId` 只有在来源能精确绑定当前 active turn 时才返回；
- `running` 不自动意味着 `interrupt.available`；
- provider 身份完全留在后端，不向 Web 暴露 `owned_app_server / external_codex`、AppServerSession、socket、路径等实现细节；Web 只知道这是经过验证的 `exact_codex_turn` 控制能力；
- 当前只有 owned App Server provider 可用；目标 Mac / `codex-cli 0.147.0` 的 external provider Gate 已失败，因此 non-owned active turn 明确返回 `provider_unverified`；只有上游控制契约发生实质变化后才重新 Gate；
- provider 选择不能只看 creation client，必须以**当前 active turn 的可控证据**为准；
- 对 dsh 不复用 Codex 中断设计，除非 dsh Host 未来显式增加对应 contract。

### 3.2 Session Metadata Resolver：逐字段事实聚合（已实现）

已增加内部 `SessionMetadataResolver`，对 Web 暴露稳定的 `WebSessionMeta`，前端不直接拼接 Hook、native DB 和 Action 参数：

```typescript
interface WebSessionMeta {
  model?: {
    id: string;
    displayName?: string;
  };
  reasoningEffort?: string;
  executionPolicy?: {
    sandbox?: "danger_full_access" | "workspace_write" | "read_only";
    approval?: "never" | "on_request";
  };
}
```

实现中的合并优先级按**字段语义 + freshness + scope**，而不是把整组 metadata 从某个来源覆盖：

- Sea-Bridge owned active turn：实际 Action 启动参数是该 turn 的强事实，提供 model / sandbox / approval；
- fresh Hook `model`：可作为当前 active turn 的实时 model 事实；
- App Server thread catalog：提供持久 session snapshot 的 `model / reasoningEffort`，并缓存到 Sea-Bridge 自有 catalog；
- model catalog 只补充 display name，不参与事实选择；
- Hook `permission_mode` 虽以 allowlist 形式保存，但在语义映射完成真实取证前，不直接填入 `executionPolicy`；
- 任何冲突无法可靠裁决时宁可省略该字段，不猜测。

`CodexThreadStore` 同时支持 native `model / reasoning_effort / sandbox_policy / approval_mode` 的固定 allowlist 投影，作为兼容/诊断与 contract 验证能力；**生产 Web 数据路径不会因此重新依赖 native SQLite**。Native DB schema 只探测代码内固定列名，禁止拼接来自请求的列名。

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

#### 4.3.1 v1.1.16 已建立的活动流 contract

v1.1.16 已在上述边界内增加受限 live activity projection：只读取当前 active turn 的 `assistant phase=commentary` 与固定工具摘要，不透传任意原始 payload；活动条目按发生顺序展示，最多保留最近 25 条。这里的 commentary 是 Codex 明确写入 rollout 的阶段性可见说明，不等同于、也不尝试恢复模型私有 chain-of-thought。

#### 4.3.2 v1.1.17 跟随最新语义

活动流与消息滚动必须遵守用户显式意图：

- 用户点击“回到最新”后进入持续 follow-latest，后续 3 秒轮询和新增 activity 继续保持在尾部；
- 用户手动把消息区上滚离开底部后，立即退出 follow-latest，后续轮询不得强行拉回；
- live activity 自己的内部滚动默认跟随最新条目；用户手动上滚查看旧条目时暂停内部自动跟随，回到最新动作重新恢复；
- session-list 轮询只能更新摘要字段，不能在随后的 history refresh 之前清空 `activeTurnItems / startedAt / turnControl` 等 history-only runtime detail，避免活动卡片高度抖动、↓ 快捷键反复出现或最新 commentary 被旧快照覆盖；
- history DOM 因消息变化重建后，活动卡片自己的 DOM cache/signature 必须同步失效并立即重建，不能留下空流或旧引用。

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

v1.1.8 保持不显示伪造 metadata；Phase D 已将它提升为正式能力，并继续坚持字段级 fail-closed。

展示规则：

- `model`：只有 resolver 得到真实 model id 时展示；若 catalog 可用，用 catalog 补 display name，catalog 不可用则显示真实 id；
- `reasoningEffort`：只有 App Server thread snapshot 或其他已验证来源给出时展示；
- `executionPolicy`：只展示已经证明语义等价的 `sandbox / approval` 字段；不能把 Hook `permission_mode` 直接翻译成“完全访问”；
- 字段可以部分存在，例如只显示 `GPT-5.6`，不能因为 reasoning 缺失就隐藏 model，也不能补一个默认“中”；
- 新建会话弹窗继续展示可选模型目录，但“可选模型”与“当前会话真实模型”是两条不同事实链；
- **当前会话 model 不是只读装饰**：Composer 中 model 展示位置本身就是下拉选择器；Codex idle 会话加载实时 `model/list` 后可直接切换该 thread 的后续模型，running / waiting approval / offline 状态保留当前值但直接禁用下拉。

推荐视觉保持弱提示，不抢占输入：

```text
GPT-5.6 · 中 · Full Access
```

其中每一段都必须来自独立真实字段；缺哪段就省略哪段。UI 不展示 provenance/source 等内部诊断信息，必要时只在诊断页提供。

#### 6.3.1 当前会话模型切换

模型切换必须是 **thread-scoped**，不能修改全局默认模型，也不能借 `codex queue` 猜测携带 model。实现契约：

1. model 展示位置直接使用原生下拉控件，不再增加二级弹窗或冗余说明；仅 Codex、在线、服务端已确认 idle 时启用，其他状态直接 disabled，并必须像主停止按钮一样有明确不可用视觉反馈（降低透明度 + not-allowed），同时提供对应 title/ARIA 原因；
2. 选项必须来自实时 `model/list`，浏览器不能提交目录外 model；
3. 后端启动临时 App Server，先 `thread/resume` 获取该 idle thread 的 writer；若返回 `already has an active writer`，以 `model_update_busy` fail closed；
4. 在同一临时 session 调用实验性 `thread/settings/update { threadId, model }`；
5. 随后用 `thread/read(includeTurns=false)` 回读，只有 `thread.model` 与请求完全一致才返回 `updated`；
6. 无论成功失败都 `thread/unsubscribe`（已 resume 时）并关闭临时 session，不长期持有 writer；
7. 审计只记录 thread identity + outcome，不记录 model id；
8. 设置成功后 Web 使用这条 readback 已确认事实覆盖旧 catalog/Hook snapshot，直到持久 snapshot 与之收敛；若之后出现更新时间更晚且冲突的 Hook/thread 证据，则让更新证据接管；
9. 模型切换成功或失败都必须通过顶部消息区反馈：成功为 transient success，业务失败为 sticky error；网络失败进入连接恢复时，顶部连接消息需明确包含“模型切换失败”的上下文，不能静默恢复旧值。

这与 external active-writer interrupt Gate 不矛盾：**running external thread 仍不能跨 App Server 接管；只有已证实 idle 且 `thread/resume` 实际成功的 thread 才允许修改持久 settings。**

### 6.4 主按钮状态机

Composer 使用与 Codex 一致的**单主按钮**，不并排放置 Send / Stop 两个按钮。按钮语义首先响应用户当前是否有草稿，再由后端 capability 决定能否执行：

#### Interrupting

- 已经发出 exact-turn interrupt 请求后，无论输入框里是否又出现草稿，主按钮保持 `正在中断…` 且 disabled；
- 只有 matching terminal evidence 到达后才退出该状态。

#### 有草稿

- 主按钮始终显示 `↑ 发送`；
- 是否可点击继续由现有 `sendEnabled`、连接状态和 `state.pending` 决定；
- running 本身不能把一个本来允许 queue/send 的会话禁用；
- Sea-Bridge-owned 首轮如果当前 `sendEnabled=false`，仍显示发送形态但保持 disabled，不因为 UI 对齐而偷偷引入未经验证的 `turn/steer`。

#### 无草稿 + active（`running` / `waiting_external_approval`）

- 主按钮显示 `⏹ 中断`，保持所有 active Codex 会话视觉结构一致；
- exact interrupt provider available：按钮可点击，点击时捕获当前**精确 `turnId`**；
- provider unavailable / unverified / turn unknown：仍显示停止形态，但 disabled，并提示 `当前会话不支持远程中断`；
- offline / reconnecting：停止按钮 disabled；
- external Desktop / CLI / queue active writer 因目标 Mac Gate FAIL，属于上述 disabled stop 状态，不显示假的可用能力。

#### 无草稿 + Idle / Unknown

- 主按钮显示 `↑ 发送` 且 disabled；
- 不因为历史上存在 active turn 或 stale capability 而继续显示可用停止。

该状态机保持一个主按钮，并明确区分“按钮形态”与“能力可用性”：**显示 `⏹` 不等于后端存在 interrupt provider，只有 enabled 才代表可执行。**

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
- 默认隐藏；仅在用户真实滚动消息窗口时，在靠近输入框上边沿的位置显示 `已加载第 X 轮` 或 `当前第 X 轮 · 已加载 N 轮`；
- 透明度与上下浮动箭头一致，避免长期抢占视觉注意力；
- 程序化 follow-latest、轮询或 activity 自增长触发的 scroll 事件不得显示该提示；
- 不能显示伪造的全局 `X / Y`；
- 停止滚动约 6 秒后隐藏；
- 点击打开已加载轮次抽屉；
- 抽屉顶部提供现有“加载更早”能力，用户加载历史后列表实时扩展。

### 7.4 可访问性

- 刻度必须可键盘 focus；
- 使用 `aria-label="跳到已加载第 N 轮：摘要"`；
- `prefers-reduced-motion: reduce` 时关闭平滑滚动与不必要动画；
- 不仅依赖颜色表达当前轮次；
- 深色主题下移动端轮次抽屉必须显式覆盖全局 primary button 配色：普通轮次使用深色 surface + 高对比正文/摘要，active/hover 使用独立深色层级，不能出现浅色按钮底 + 灰字的低对比组合。

---

## 8. 中断能力详细设计

### 8.1 Owned provider Contract Gate（已完成）

v1.1.8 在实现 Web 按钮前，已用目标机 `codex-cli 0.147.0` 证明：

1. Sea-Bridge `startThreadAndTurn()` 的 owning `AppServerSession` 在 turn 活跃期间可以并发调用 `turn/interrupt`；
2. RPC 参数是精确 `threadId + turnId`；
3. 中断后同一 session 收到与该 `turnId` 对应的 `turn/completed`；
4. 状态可可靠区分 `interrupted`、自然 `completed`、already completed / too late；
5. 中断完成后仍执行一次 `thread/unsubscribe`，writer ownership 正常释放；
6. Desktop 随后能重新打开该 thread，不出现残留 writer；
7. 连续点击 / 网络重复请求不会误中断后续新 turn。

该 Gate 已通过，因此 `OwnedAppServerInterruptProvider` 可作为 v1.1.8 的正式 provider。这个 PASS **只证明 owning-session 路径**，不能自动推广为 Desktop / CLI / queue 的跨实例 contract。

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
- `409 interrupt_provider_unverified`
- `409 active_turn_changed`
- `409 interrupt_already_finished`
- `503 interrupt_provider_unavailable`

`interrupt_not_owned` 仅作为 v1.1.8/兼容错误映射保留，不再作为新的 Web capability 语义；“非 owned”不等于永久不可控。

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

后端必须返回 `active_turn_changed`（或在 provider 尚未验证时 `interrupt_provider_unverified`），绝不能自动把目标切换到 turn B。

### 8.5 与 provisional interrupted 的兼容

现有 observer 已经处理独立 ReadService 对运行中 turn 短暂误投影 `interrupted` 的问题。本功能不能破坏该规则。

只有以下证据之一成立时，Web / Telegram 才能把目标 turn 确认为真实 interrupted：

- 官方终态带可信 completion evidence；
- 精确 Interrupt Hook 对应同一个 turn；
- owning Action session 收到同 turn 的正式 terminal 通知并满足现有 contract。

### 8.6 Universal Interrupt Provider 架构（Router/owned provider 已实现）

当前实现没有在 `CodexWebSource` 里堆更多 `if (desktop/cli)` 分支，而是增加统一后端路由：

```typescript
interface InterruptRequest {
  threadId: string;
  expectedTurnId: string;
}

interface InterruptProvider {
  id: "owned_app_server" | "external_codex";
  capability(input: InterruptRequest): Promise<
    | { status: "available" }
    | { status: "unavailable"; reason: string }
  >;
  interrupt(input: InterruptRequest): Promise<
    | { status: "interrupting" }
    | { status: "turn_changed" }
    | { status: "already_finished" }
  >;
}
```

`InterruptRouter` 负责：

1. 先用 exact `threadId + expectedTurnId` 查询已验证 provider；
2. owned registry 精确匹配时优先 `owned_app_server`；
3. 非 owned running turn 只有在 `external_codex` 对当前目标机/版本已通过 Gate 后才可用；
4. 没有 provider 时返回 `provider_unverified / provider_unavailable`，绝不能尝试“先 resume 看看”；
5. provider 选定后本次请求固定绑定该 provider 和 `expectedTurnId`，中途不得切换到另一 provider 或另一个 turn；
6. 最终 interrupted 仍由 terminal evidence 确认，provider RPC success 只代表接纳。

#### External provider Contract Gate — VERIFIED / FAIL

2026-10-12 已在目标宿主 `Darwin MacBookProM5Nvy.local 25.5.0 arm64`、`codex-cli 0.147.0` 上完成双 App Server 实测：

1. Writer A 持有外部 active thread / turn；
2. Writer B 直发 `turn/interrupt(threadId, expectedTurnId)`：返回 `-32600 thread not found`；
3. Writer B 尝试 `thread/resume`：返回 `-32600 already has an active writer`；
4. Writer B 尝试 `turn/steer`：同样返回 `-32600 thread not found`；
5. `~/.codex/app-server-control/app-server-control.sock` 不存在，当前官方部署没有跨进程共享控制总线；
6. 结论：独立 App Server 无法在 writer-safe 前提下介入外部活跃 thread，Contract Gate 判定 **FAIL**。

生产裁决已经固定：

- 不注册 `ExternalCodexInterruptProvider`；
- non-owned external active turn 返回 `provider_unverified` 并 fail closed；
- 不尝试 resume 后重试 interrupt，不尝试 steer 替代 interrupt；
- 不用 kill / pkill / SIGINT 整个进程冒充 turn interrupt；
- 只有未来 Codex 官方引入新的共享控制或 writer-safe attach/control contract 时，才重新执行新的目标机 Gate。

#### 不采用的方案

- 不直接把 `DesktopSameSessionAdapter.interrupt()` 改成“启动第二 App Server 然后 resume/interrupt”；
- 不通过 kill Codex/Desktop 进程实现“停止”；
- 不根据 thread creation client 直接推断 provider 可用；
- 不使用“当前最新 active turn”替代客户端点击时的 `expectedTurnId`。

这样可以实现最终产品目标——**所有有精确 active-turn 证据且存在已验证 provider 的 Codex running 会话都显示同一个停止按钮**——同时不牺牲 writer 安全。

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

Phase A-C 已由 v1.1.8 完成；本轮又完成了 Phase D 以及 Phase E 的 Router/owned-provider 基础。External provider 的真实目标 Mac Contract Gate 也已完成并判定 FAIL，因此当前 Phase E 的正确收口是：owned provider 保持可用，external active-writer provider 明确不注册并 fail closed。后续不再把“补 external provider”作为当前版本待办；只有上游控制契约变化后才重新立项验证。

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

### Phase D：Session Metadata Contract — DONE

- 生产路径从 App Server thread catalog 读取 `model / reasoningEffort` 并缓存到 Sea-Bridge catalog；
- `CodexThreadStore` 同步支持 native metadata 的固定 allowlist 投影，作为兼容/诊断能力；
- Hook/session state 只保存 allowlist metadata，不保存 tool input / prompt / reasoning；
- `SessionMetadataResolver` 按字段 freshness/scope 合并 Action、Hook、thread snapshot；
- WebSource 投影 `WebSessionMeta`；
- Composer 逐字段显示模型 / reasoning / execution policy，未知字段不补默认值。

### Phase E：Universal Codex Interrupt — DONE WITH VERIFIED EXTERNAL LIMITATION

- `InterruptRouter` / provider interface 已实现；
- v1.1.8 owned-turn 能力已包装为 `OwnedAppServerInterruptProvider`；
- Web 已收敛到 provider-independent `exact_codex_turn` capability 与同一个 `POST .../interrupt`；
- provider selection / no-fallback-after-dispatch / stale-turn 防护已有自动化测试；
- 目标 Mac / `codex-cli 0.147.0` 的 external provider Contract Gate 已执行并判定 FAIL，证明独立 App Server 无法 writer-safe 控制外部 active writer；
- production 不注册 `ExternalCodexInterruptProvider`，non-owned external active turn 明确 `provider_unverified` fail closed；未来只有上游控制 contract 发生实质变化后才重新 Gate。

### Phase F：可选增强

- 安全微活动 projection；
- 用户显式开启的一键直发快捷操作；
- dsh interrupt（需独立 Host contract）；
- 其他不影响核心控制正确性的体验增强。

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
3. 未知模型 / reasoning / 权限不会显示伪造值；已取证字段允许独立显示；
4. running / waiting approval 且空草稿时显示 `⏹ 中断` 形态；没有已验证 provider 时按钮 disabled，有 verified provider 时才可点击；
5. active 会话出现非空草稿后主按钮立即切换为 `↑ 发送`，enabled 状态继续服从 `sendEnabled / paused / pending`；
6. operation `delivery_unknown` 仍保留“结果待确认”，不会被 running 状态掩盖。

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
8. Phase E external provider Gate 已在目标 Mac 判定 FAIL，因此 Desktop / CLI / queue 启动的 non-owned active turn 在空草稿时只显示 disabled 停止形态；有草稿时仍按现有 queue/send 语义显示发送；
9. 不通过已证明不可行的第二 App Server resume/interrupt 路径强行介入 non-owned thread；
10. owned active turn 有草稿时主按钮切为发送；若 `sendEnabled=false` 则保持 disabled，不引入未经验证 steer；
11. 现有 provisional interrupted → completed correction 逻辑无回归。

### 11.6 Session Metadata Contract

1. App Server thread metadata 缺失时仍可正常读取基础 thread；native compatibility store 缺少任一可选 metadata 列也不影响基础读取；
2. 只有真实存在的 metadata 才进入 resolver；生产 thread snapshot 当前使用 `model / reasoningEffort`，owned Action 可提供 sandbox/approval；
3. Hook `model` 可作为 fresh active-turn model 事实，但 `permission_mode` 未经映射验证不能伪装成 sandbox/approval；
4. Sea-Bridge owned turn 的实际 Action 参数可作为该 turn 强事实；
5. conflicting/stale evidence 无法裁决时省略字段，不猜测；
6. model catalog 只做 display-name enrichment，目录失败不改变 model id；
7. Web response 不包含 native DB path、Hook transcript path、tool input、prompt、reasoning；
8. Composer 可以只显示部分 metadata，例如只有 model，不补默认 reasoning；
9. 不同 Codex schema profile 有 fixture / target-machine 验证。

### 11.7 Universal Codex Interrupt

对每个新 external provider：

1. Contract Gate 必须在真实目标机、真实 Codex 版本上完成；
2. capability 必须绑定 exact active `threadId + turnId`；
3. stale A interrupt 在 B 已开始后不得停止 B；
4. provider RPC 接纳后 UI 保持 interrupting，直到 terminal evidence；
5. Desktop / CLI / queue 原 writer 不出现双 writer、死锁或残留 ownership；
6. provider unavailable / unsupported version 必须 fail closed；
7. Web endpoint 与按钮不因 provider 类型改变；
8. provider 选择在请求开始后固定，不能中途 fallback 到另一个 provider；
9. 不以 kill process / signal 作为正常 interrupt fallback；
10. external provider Gate 全部未通过时，v1.1.8 owned provider 行为保持无回归。

---

## 12. 实际修改范围与剩余范围

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

Phase D 已增加/调整：

- `src/desktop/codex-read-service.ts` / `src/desktop/codex-catalog-store.ts`：生产 thread model/reasoning 投影与缓存；
- `src/desktop/codex-thread-store.ts`：native metadata 固定 allowlist 兼容投影；
- `src/desktop/session-state.ts` / Hook provider：保存 allowlist live metadata；
- `src/desktop/session-metadata-resolver.ts`：字段级事实聚合；
- `src/web/sources/types.ts` / `src/web/sources/codex.ts`：投影 `WebSessionMeta`；
- `src/web/public/app.js` / `app.css` / `index.html`：Composer metadata badges；
- additive DB migration 与 schema/resolver/privacy/UI tests。

Phase E 已增加/调整：

- `src/desktop/interrupt-provider.ts`：`InterruptProvider`、`InterruptRouter`、`OwnedAppServerInterruptProvider`；
- `src/web/sources/codex.ts`：provider-independent capability / router dispatch；
- Web HTTP endpoint 保持不变，并增加 `interrupt_provider_unverified` 稳定错误；
- provider pinning、no fallback after dispatch、stale-turn 和 non-owned verified capability tests。

Phase E 当前收口：

- 真实目标 Mac Contract Gate 已完成，跨实例 external provider 在 `codex-cli 0.147.0` 上判定 FAIL；
- 不新增、不注册 `ExternalCodexInterruptProvider`；
- `src/desktop/same-session-adapter.ts` 保留 `UNAVAILABLE_DESKTOP_INTERRUPT`；
- 只有未来上游新增共享控制总线或 writer-safe attach/control contract 后，才重新 Gate 并评估是否移除该 unavailable。

因此 `UNAVAILABLE_DESKTOP_INTERRUPT` **当前不是“尚未实现”的占位，而是基于真实目标机 Gate 的明确安全结果**。

---

## 13. 最终设计裁决

v1.1.8 已正确完成 Phase A-C；当前工作区已继续完成 Phase D 与 Phase E provider/router，并完成 external provider 目标机 Gate。当前结论不是“继续等待同一路径实现 Universal Interrupt”，而是明确接受 Codex 0.147.0 的单 writer 隔离：owned turn 可中断，external active-writer turn fail closed。

最终产品目标明确为：

1. **Composer 展示真实会话 metadata**：model / reasoning / execution policy 逐字段取证、逐字段显示，不猜默认值；
2. **所有可精确定位 active turn 且存在已验证 provider 的 Codex running 会话统一支持中断**，不要求用户理解 Web / Telegram / Desktop / CLI / queue 的来源差异；
3. Web 始终使用稳定的 exact-turn API，metadata resolver 与 interrupt router 在后端吸收 Codex 版本和来源差异；
4. 每新增一种事实来源或控制 provider，都先建立 contract、fixture、真实目标机 Gate，再开放 capability；
5. 安全不是“永久隐藏能力”，而是“未验证时 fail closed，验证通过后通过统一契约开放”。

因此后续优先级已经收敛为：

- **无当前 P1 external interrupt 实现项**：本轮 Gate 已失败，保持安全边界；仅在 Codex 上游控制契约变化时重新评估；
- **P2：Phase F 安全微活动 / opt-in 一键直发等体验增强**。

微观工具活动继续保持严格 allowlist；快捷胶囊默认仍只填入输入框。这两项当前设计无需改变。
