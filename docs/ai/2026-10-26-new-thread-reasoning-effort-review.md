# 新建会话模型推理强度选择代码审查报告

- **仓库及路径**: /opt/app/aitools/sea-bridge
- **基线 (Base ref/commit)**: main (77e2243)
- **候选 Tree SHA**: 8e52680c6c350d96a3aad718f209cf819e07f2d6
- **分支**: codex/new-thread-reasoning-effort
- **审查日期**: 2026-10-26
- **审查结论**: PASS

---

## 1. 审查范围与改动文件

- **src/desktop/codex-app-server-client.ts**:
  - `ModelOption` 与 `ModelListResponse` 扩展 `defaultReasoningEffort` 与 `supportedReasoningEfforts` 字段；
  - `listModels()` 解析并提取底层 RPC 返回的默认推理强度与支持的档位数组；
  - `startThreadAndTurn()` 接收可选 `reasoningEffort`，在启动轮次时向 `turn/start` 传入 `effort: params.reasoningEffort`，并在内存 `ownedTurns` 元数据中保留该配置。
- **src/desktop/codex-read-service.ts**:
  - `ModelListResponse` 与 `listModels()` 同步扩展推理强度元数据解析能力。
- **src/web/sources/types.ts**:
  - `CatalogItem` 扩展可选 `defaultReasoningEffort` 与 `supportedReasoningEfforts`；
  - `CreateRequest` 扩展可选 `reasoningEffort?: string | null`。
- **src/web/sources/codex.ts**:
  - `models()` 透传模型的推理档位元数据；
  - `create()` 校验模型推理强度支持列表，未声明支持时拒绝非法档位；合法时透传至 `startThreadAndTurn`。
- **src/web/operations.ts**:
  - `WebWriteRequest` 增加 `reasoningEffort` 并在 `dispatchWebOperation` 中向来源透传。
- **src/web/http.ts**:
  - 在 `POST /api/sessions` 中提取并校验 `reasoningEffort`（严格限定长度 <= 80 且仅含英文字符/下划线/连字符），非法格式抛出 400 `invalid_reasoning_effort`。
- **src/web/public/index.html**:
  - 在新建会话弹窗表单中增加 `#create-reasoning-effort` 下拉框及其标签。
- **src/web/public/app.js**:
  - 新增 `syncReasoningEffortControl()`：根据选中的模型动态填充对齐桌面端默认视野的档位选项（低/轻度、中、高），当模型不支持推理时自动禁用下拉框；
  - `setConnectionControls` 与 `clearSensitive` 安全纳入新下拉框的禁用与重置状态；
  - `submitWrite(create)` 组装请求参数时包含选中的推理强度。
- **tests/**:
  - `tests/codex-app-server-client.test.ts`：更新 `listModels()` 与 `startThreadAndTurn()` 的推理强度断言；
  - `tests/codex-read-service.test.ts`：新增只读服务模型列表推理能力测试；
  - `tests/web-reasoning-effort.test.ts`：新增涵盖模型接口、API 参数合法与非法校验、前端 DOM 联动与状态同步的端到端测试。

---

## 2. 审查项与核查结论

### 2.1 契约匹配性与对齐 Desktop 视野
- 选项严格收敛为「使用模型默认设置」以及常规的「低（轻度）」、「中」、「高」三档，完全符合用户确定的方式一；
- 当选择如 `gemini-3.1-flash-image` 或 `gpt-oss-120b-medium` 等不支持推理强度的模型时，下拉框自动切换为禁用状态并重置为默认，交互反馈准确、无歧义；
- 底层参数映射准确：`model/list` 中的 `defaultReasoningEffort` / `supportedReasoningEfforts` 与 `turn/start` 中的 `effort` 命名转换精准无遗漏。

### 2.2 安全性、依赖与输入防护
- 服务端增加安全正则 `^[a-zA-Z0-9_-]{1,80}$` 校验，杜绝任何特殊字符或过长字符串注入；
- 前端纯采用 `node()`（`document.createElement` + `textContent`）与 `replaceChildren()` 操作 DOM，无 `innerHTML` 注入隐患；
- 无新增任何外部依赖，完全符合项目的无依赖/锁文件规约。

### 2.3 异常边界与向后兼容
- 旧版数据或 Mock 测试数据若未返回 `supportedReasoningEfforts` 字段，均有安全兜底与可选链，不会引发 TypeError；
- 新建会话若未选择推理强度（保持默认），不向底层传递冗余字段，保持与原有行为完全一致。

---

## 3. 门禁验证证据

- **全量测试套件**: `bun test` 502 pass / 0 fail / 2360 expect calls (覆盖 74 个测试文件)。
- **类型系统检查**: `bun run typecheck` (`bunx tsc --noEmit`) 0 errors。
- **静态资源规范**: `bun test tests/web-static.test.ts` 全部通过（字体、zoom、localStorage 与 safe rendering 均符合标准）。
- **生产打包构建**: `bun run build` (`bun run scripts/build.ts`) 构建成功，资源打包正常。

---

## 4. 审查结果

- **Critical**: 0
- **Warning**: 0
- **Suggestion**: 0
- **结论**: **PASS**

