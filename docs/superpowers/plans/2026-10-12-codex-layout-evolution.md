# Sea-Bridge 借鉴 Codex 原生布局体验升级实施计划 (Implementation Plan)

- **Goal**: 将 Sea-Bridge 会话详情与控制体验向 Codex 原生布局对齐，实现“安全运行态活动卡片、已加载轮次指示轨、输入框控制台化与安全快捷选项填入（Phase A）”，并为拥有者轮次中断构建严谨的 PoC 验证与接入链路（Phase B/C）。
- **Architecture**: 保留 Sea-Bridge 现有的 REST + SSE + 3 秒轮询数据链路。前端基于 DOM 节点（textContent，严防 XSS）渲染安全活动卡片与轮次刻度；输入框重构为自适应高度 + 下层状态栏；快捷胶囊仅将用户可见短选项填入输入框；中断严格限定于 Sea-Bridge 自有 Action Session 的精确 turnId 契约。
- **Tech Stack**: TypeScript, Bun test, 原生 Web API (DOM, CSS Flexbox/Grid, IntersectionObserver), Node/Bun child_process 与 JSON-RPC。
- **Reference Spec**: [docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md](/opt/app/aitools/sea-bridge/docs/superpowers/specs/2026-10-12-codex-layout-evolution-design.md:1)

---

## 涉及文件与职责划分 (File Structure)

- `src/web/public/index.html`: 声明活动卡片容器、输入框控制栏结构与轮次指示轨挂载点。
- `src/web/public/app.css`:
  - `.live-activity-card`: 运行态活动卡片样式与计时器微光动效。
  - `.turn-rail` & `.turn-tick`: 桌面端垂直刻度标尺；移动端浮动轮次胶囊与轮次跳转抽屉。
  - `.composer`: 输入框区域视觉重塑，支持弹性高度输入区与底部控制行（状态/模型占位/主操作按钮）。
  - `.action-pills`: 助手气泡底部快捷填入胶囊样式。
- `src/web/public/app.js`:
  - 活动卡片生命周期管理：基于 `session.state === 'running'` 与 `activeTurnStartedAt` 挂载/卸载/本地每秒对齐。
  - 选项解析引擎：从 assistant 最终回复中安全提取明确选项短语并渲染胶囊；点击仅填入输入框。
  - 轮次轨维护：基于当前已加载的执行态 user message 生成刻度，绑定 `IntersectionObserver`，处理 `replaceChildren()` 后的重连。
  - Composer 状态机：支持 Idle 发送状态与运行态提示。
- `tests/web-message-ui.test.ts`: 针对活动卡片、轮次轨、快捷胶囊和 Composer 改造补充全面的 UI 状态、安全与无回归测试。
- `tests/fixtures/app-server-mock.ts` (Phase B): 构建符合 Codex app-server 规范的 mock 实例，验证 `turn/interrupt`。
- `src/desktop/codex-app-server-client.ts` (Phase B/C): 扩展 `interruptTurn(threadId, turnId)` 并维护 owning turns。
- `src/web/http.ts` (Phase C): 增加 `POST /api/sessions/codex/:id/interrupt` 端点。

---

## 实施任务分解 (Tasks)

### Task 1: 运行态安全活动卡片 (Live Activity Card - Phase A)

**目标**: 当会话处于 `running` 且有 `activeTurnStartedAt` 时，在消息流尾部动态挂载活动卡片，本地每秒跳动耗时；当切回 `idle` 或交付回复时平滑清理。绝不展示未经验证的命令或文件路径。

- **Step 1.1**: 在 `tests/web-message-ui.test.ts` 中编写活动卡片测试：
  - 测试用例 1: 会话处于 `running` 且有 `activeTurnStartedAt` 时，`#messages` 尾部存在 `.live-activity-card`，包含运行状态与绝对计时。
  - 测试用例 2: 计时基于绝对时间戳计算，经历多次渲染或前后台切换后计时不重置。
  - 测试用例 3: 当状态切为 `idle` 时，活动卡片自动从 DOM 移除，不污染历史消息。
- **Step 1.2**: 运行测试确认失败：`bun test tests/web-message-ui.test.ts`。
- **Step 1.3**: 在 `src/web/public/app.css` 中添加 `.live-activity-card` 相关样式。
- **Step 1.4**: 在 `src/web/public/app.js` 中实现 `syncLiveActivityCard()`：
  - 在 `loadHistory()` 和 `renderSessionStatus()` 中调用，利用已有的 `state.selected.startedAt` 与 `state.selected.state`。
  - 动态创建/更新 DOM 节点，使用 `textContent` 保证安全。
- **Step 1.5**: 运行测试确认通过：`bun test tests/web-message-ui.test.ts`。
- **Step 1.6**: 提交代码：`git commit -m "feat(web): add live activity card for active turns"`。

---

### Task 2: 选项快捷操作胶囊 (Quick Action Pills - Phase A)

**目标**: 从助手回复中提取明确可见的短选项（如“选项 1：...”、“回复「继续」...”），在气泡底部右下角渲染药丸按钮；点击仅将完整文本安全填入输入框并聚焦。

- **Step 2.1**: 在 `tests/web-message-ui.test.ts` 中编写快捷胶囊测试：
  - 测试用例 1: 助手回复中含有明确选项结构时生成胶囊按钮。
  - 测试用例 2: 普通文本、代码块 (```)、表格和引用块中的文本**不**被提取。
  - 测试用例 3: 点击胶囊后，按钮完整可见文本填入 `#prompt`，输入框聚焦且不会自动发包。
  - 测试用例 4: 胶囊数量限制为最多 4 个，单条文本截断或忽略超长内容。
- **Step 2.2**: 运行测试确认失败：`bun test tests/web-message-ui.test.ts`。
- **Step 2.3**: 在 `src/web/public/app.css` 中添加 `.action-pills` 和 `.action-pill` 样式。
- **Step 2.4**: 在 `src/web/public/app.js` 中实现安全的 `extractActionPills(text)` 和 `renderActionPills(container, options)`，并在助手消息渲染流程中挂载。
- **Step 2.5**: 运行测试确认通过：`bun test tests/web-message-ui.test.ts`。
- **Step 2.6**: 提交代码：`git commit -m "feat(web): add safe quick action pills for visible options"`。

---

### Task 3: 已加载轮次指示轨 (Loaded Turn Rail - Phase A)

**目标**: 双端响应式已加载轮次导航。桌面端展示左侧微型刻度线并支持 hover 预览与点击跳转；移动端滑动时在右下角展示“已加载第 X 轮”胶囊并支持轮次跳转抽屉；处理好 `replaceChildren()` 后的 observer 重新绑定。

- **Step 3.1**: 在 `tests/web-message-ui.test.ts` 中编写轮次轨测试：
  - 测试用例 1: 仅对当前 DOM 中已加载且已进入历史的 user message 建立刻度，待发送 (`queued`) 不计入。
  - 测试用例 2: 点击刻度能定位到对应 user message。
  - 测试用例 3: 历史翻页 (`loadHistory(older)`) 扩展后，刻度数量同步增加。
  - 测试用例 4: 移动端视口下不展示伪造的全局总轮次，仅展示已加载轮次指示。
- **Step 3.2**: 运行测试确认失败：`bun test tests/web-message-ui.test.ts`。
- **Step 3.3**: 在 `src/web/public/index.html` 和 `app.css` 中增加 `.turn-rail`、`.turn-tick` 及移动端轮次指示器样式。
- **Step 3.4**: 在 `src/web/public/app.js` 中实现 `syncTurnRail()`：
  - 构建基于已加载 user messages 的刻度模型；
  - 绑定 `IntersectionObserver`（以 `#messages` 为 root）；
  - 维护桌面端刻度与移动端微型悬浮指示器的动态更新。
- **Step 3.5**: 运行测试确认通过：`bun test tests/web-message-ui.test.ts`。
- **Step 3.6**: 提交代码：`git commit -m "feat(web): add loaded turn timeline rail and navigation"`。

---

### Task 4: 输入框控制台化与状态重构 (Composer Control Hub - Phase A)

**目标**: 重构输入框区域视觉结构：保持 1～3 行自适应扩展，拆分出底部控制行（运行态/连接状态提示 + 发送按钮）；在不具备真实会话元数据时不展示伪造的模型与权限徽标；当会话处于运行中时主按钮保持安全状态，不误标为可用中断。

- **Step 4.1**: 在 `tests/web-message-ui.test.ts` 中编写 Composer 重构测试：
  - 测试用例 1: 输入框自适应 1～3 行高度与手机视口键盘唤起保持正常无回归。
  - 测试用例 2: `running` 且无中断支持时，主按钮禁用或保持普通状态，状态栏展示当前耗时。
  - 测试用例 3: 未知模型与权限不渲染伪造标签。
- **Step 4.2**: 运行测试确认失败：`bun test tests/web-message-ui.test.ts`。
- **Step 4.3**: 在 `src/web/public/index.html` 和 `app.css` 中重构 `.composer` 布局（上层输入框，下层控制与操作栏）。
- **Step 4.4**: 在 `src/web/public/app.js` 中调整 Composer 状态更新逻辑，确保与现有 `operation-status`、手机软键盘适配完全兼容。
- **Step 4.5**: 运行测试确认通过：`bun test tests/web-message-ui.test.ts`。
- **Step 4.6**: 提交代码：`git commit -m "refactor(web): modernize composer layout into control hub"`。

---

### Task 5: Phase A 端到端集成验证与测试套件回归 (Phase A Integration Gate)

**目标**: 运行完整测试套件，验证 Phase A 四项改造无任何破坏性回归，符合各项安全与无无害渲染约束。

- **Step 5.1**: 运行全量测试套件：`pnpm test`。
- **Step 5.2**: 验证 static asset 构建与打包无遗漏：`bun run build 2>/dev/null || true`。
- **Step 5.3**: 提交集成阶段里程碑：`git commit -m "chore: complete Phase A UI and interaction enhancements"`。

---

### Task 6: Owned-turn Interrupt 契约验证 PoC (Phase B Contract Gate)

**目标**: 为目标环境的 Codex `app-server` 构建集成测试/PoC，验证同一个 owning `AppServerSession` 能否在首轮活跃期间成功并发调用 `turn/interrupt` 并释放 writer ownership。

- **Step 6.1**: 在 `tests/codex-app-server-client.test.ts` 中编写 PoC 测试：
  - 验证 `turn/interrupt` 的 JSON-RPC 请求结构带精确 `threadId` 和 `turnId`。
  - 验证同一 session 下收到 `turn/completed` 或 `interrupted` 事件后顺利释放 session 并触发 `thread/unsubscribe`。
  - 验证竞态：若 turn 已结束，RPC 报错或返回后不会影响后续新 turn。
- **Step 6.2**: 运行测试，根据结果评估 contract 是否成立。
- **Step 6.3**: 若成立，进入 Phase C；若不成立，记录评估结果并保持中断不可用。

---

### Task 7: Owned-turn Interrupt 端到端接入 (Phase C - 仅在 Task 6 通过后)

**目标**: 在后端实现 `interruptOwnedTurn` 与 `POST /api/sessions/codex/:id/interrupt`，在前端精确绑定 `expectedTurnId`，在运行态将 Composer 主按钮翻转为 `⏹ 中断`。

- **Step 7.1**: 在 `tests/web-codex-source.test.ts` 和 `tests/web-http.test.ts` 编写中断端点与竞态拦截测试。
- **Step 7.2**: 在 `src/desktop/codex-app-server-client.ts` 中实现 `interruptOwnedTurn()`。
- **Step 7.3**: 在 `src/web/http.ts` 中暴露安全中断路由并接入 CSRF/权限校验。
- **Step 7.4**: 在 `src/web/public/app.js` 中将 Composer 按钮在 owned turn 运行态翻转为 `⏹ 中断`，点击带 `expectedTurnId`。
- **Step 7.5**: 运行全量测试确认通过：`pnpm test`。
- **Step 7.6**: 提交代码：`git commit -m "feat(desktop): enable owned-turn interrupt via App Server RPC"`。

