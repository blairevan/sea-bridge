# 新建会话模型推理强度选择实施计划 (Implementation Plan)

- **Goal**: 在 Sea-Bridge Web 控制台新建会话中实现推理强度（Reasoning Effort）选择，支持模型联动，提供对齐 Desktop 默认视野的选项（默认/低/中/高）。
- **Architecture**: 后端 ModelOption/CatalogItem 元数据扩展 + turn/start effort 参数适配 + Web API 校验透传 + 前端动态联动。
- **Tech Stack**: Bun, TypeScript, Vanilla JS, HTML5.
- **Spec**: [docs/ai/2026-10-26-new-thread-reasoning-effort-design.md](/opt/app/aitools/sea-bridge/docs/ai/2026-10-26-new-thread-reasoning-effort-design.md)

---

### Task 1: 编写底层模型元数据与 App Server 执行测试 (TDD)

**Files:**
- Modify: tests/codex-app-server-client.test.ts
- Modify: tests/codex-read-service.test.ts

- [ ] **Step 1: 编写测试断言**
  1. `listModels()` 能够解析并返回 `defaultReasoningEffort` 与 `supportedReasoningEfforts`；
  2. `startThreadAndTurn()` 传入 `reasoningEffort: "high"` 时，RPC 请求 `turn/start` 参数中包含 `effort: "high"`，且内部 `ownedTurns` 记录该元数据；
  3. 未传入 `reasoningEffort` 时保持兼容，不传递空 `effort` 属性。
- [ ] **Step 2: 运行测试观察 RED**
  执行 `bun test tests/codex-app-server-client.test.ts` 验证失败。

---

### Task 2: 实现底层 App Server 客户端与 Read Service

**Files:**
- Modify: src/desktop/codex-app-server-client.ts
- Modify: src/desktop/codex-read-service.ts

- [ ] **Step 1: 扩展 ModelOption 与 listModels 响应解析**
  在两处 `ModelOption` 中添加可选属性，在遍历 `model/list` 数据项时提取 `defaultReasoningEffort` 与 `supportedReasoningEfforts`（映射数组内 `reasoningEffort`）。
- [ ] **Step 2: 扩展 startThreadAndTurn**
  在参数中增加 `reasoningEffort?: string | null`，在组装 `turn/start` 请求体时根据该参数注入 `effort`。
- [ ] **Step 3: 运行测试观察 GREEN**
  执行 `bun test tests/codex-app-server-client.test.ts tests/codex-read-service.test.ts` 确认通过。

---

### Task 3: 扩展 Web 来源、派发与 HTTP API

**Files:**
- Modify: src/web/sources/types.ts
- Modify: src/web/sources/codex.ts
- Modify: src/web/operations.ts
- Modify: src/web/http.ts
- Create: tests/web-reasoning-effort.test.ts

- [ ] **Step 1: 编写 Web API 自动化测试**
  在 `tests/web-reasoning-effort.test.ts` 中测试：
  - `GET /api/sources/codex/models` 返回的条目中包含推理强度支持列表；
  - `POST /api/sessions` 接收合法 `reasoningEffort`，成功启动会话；
  - `POST /api/sessions` 遇到超长或非法字符的 `reasoningEffort` 时拒绝请求。
- [ ] **Step 2: 实现后端数据流**
  - `src/web/sources/types.ts`：更新 `CatalogItem` 与 `CreateRequest`；
  - `src/web/sources/codex.ts`：更新 `models()` 与 `create()`；
  - `src/web/operations.ts` 与 `src/web/http.ts`：扩展请求模型与参数校验。
- [ ] **Step 3: 运行测试观察 GREEN**
  执行 `bun test tests/web-reasoning-effort.test.ts` 确认通过。

---

### Task 4: 前端界面与动态交互联动

**Files:**
- Modify: src/web/public/index.html
- Modify: src/web/public/app.js
- Modify: tests/web-message-ui.test.ts

- [ ] **Step 1: 编写前端交互测试**
  在 `tests/web-message-ui.test.ts` 中测试：
  - 当模型支持推理时，`create-reasoning-effort` 包含“使用模型默认设置”以及对齐 Desktop 视野的选项（低、中、高）；
  - 当模型不支持推理时，`create-reasoning-effort` 被禁用；
  - 表单提交时正确携带选中的推理强度值。
- [ ] **Step 2: 改造 index.html 与 app.js**
  - 在 `index.html` 中添加标签与下拉框结构；
  - 在 `app.js` 中添加 `syncReasoningEffortControl()` 联动渲染逻辑；
  - 更新 `submitWrite`、`setConnectionControls` 与 `clearSensitive`。
- [ ] **Step 3: 运行前端与静态测试**
  执行 `bun test tests/web-message-ui.test.ts tests/web-static.test.ts` 确认全部通过。

---

### Task 5: 全量回归与构建检查

- [ ] **Step 1: 运行全量测试套件**
  `bun test`
- [ ] **Step 2: 运行类型检查**
  `bun run typecheck`
- [ ] **Step 3: 运行生产构建**
  `bun run build`

