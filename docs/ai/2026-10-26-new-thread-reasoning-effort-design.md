# 新建会话模型推理强度选择设计方案 (Design Specification)

- **Date**: 2026-10-26
- **Branch**: codex/new-thread-reasoning-effort
- **Project**: sea-bridge (/opt/app/aitools/sea-bridge)
- **Status**: Draft (待确认分支与执行模式)
- **Issue Source**: 飞书文档「sea-bridge需求与记录」第 5 条 (Block ID: IzoJdqnlEopk0uxTgR3cUnk3nnf)

---

## 1. 目标与背景

当前 Sea-Bridge Web 控制台新建会话弹窗（`#create-dialog`）仅支持选择执行来源（Codex / dsh）、项目、模型和首条消息。
随着思考模型（如 GPT-5.5、GPT-5.6-Sol、GPT-5.6-Terra、Claude 思考模型等）广泛应用，新建会话时无法调节推理强度（Reasoning Effort）。
用户在飞书文档第 5 条明确提出：“缺少模型的推理强度选择”。在方案分析中，用户明确选择**「方式一（对齐 Desktop 默认视野）」**，即在保持界面清晰克制的前提下，提供与 Codex Desktop 常规模型选择器一致的三档推理强度选择（低/轻度、中、高），以及缺省的“使用模型默认设置”。

---

## 2. 核心架构与协议映射

### 2.1 推理强度档位与展示文案
对齐 Codex Desktop 默认简单视图，推理强度映射表如下：
- `""`（空）：**使用模型默认设置**（缺省项，不强制覆盖模型或系统的预设值）。
- `"low"`：**低（轻度）**（对应底层 App Server 协议键值 `low`，Codex 界面称 Light/轻度）。
- `"medium"`：**中**（对应底层 App Server 协议键值 `medium`，Codex 界面称 Medium/中）。
- `"high"`：**高**（对应底层 App Server 协议键值 `high`，Codex 界面称 High/高）。

### 2.2 Codex App Server 底层客户端适配
1. **模型元数据扩展** (`src/desktop/codex-app-server-client.ts` 及 `src/desktop/codex-read-service.ts`):
   - 在 `ModelOption` 中扩展可选字段：
     ```typescript
     export interface ModelOption {
       id: string;
       displayName: string;
       defaultReasoningEffort?: string;
       supportedReasoningEfforts?: string[];
     }
     ```
   - 在 `listModels()` 消费 `model/list` RPC 响应时，安全读取各模型的 `defaultReasoningEffort` 以及 `supportedReasoningEfforts`（从数组中提取 `item.reasoningEffort` 字符串）。
2. **首轮执行传参** (`CodexAppServerClient.startThreadAndTurn`):
   - 参数扩展 `reasoningEffort?: string | null`；
   - 在调用 `turn/start` 时，如果提供了有效的非空 `reasoningEffort`，则在 RPC 参数中传入 `effort: params.reasoningEffort`；
   - 在内部记录的 `ownedTurns` 元数据中保留该 `reasoningEffort`，便于后续查询与状态跟踪。

### 2.3 Web 来源与派发层
1. **目录透传** (`src/web/sources/types.ts`):
   - 在 `CatalogItem` 接口中扩展 `defaultReasoningEffort?: string` 与 `supportedReasoningEfforts?: string[]`；
   - `CodexWebSource.models()` 返回的条目中附带对应模型的支持档位与默认档位；
   - `CreateRequest` 接口扩展 `reasoningEffort?: string | null`。
2. **请求流转与校验** (`src/web/operations.ts`, `src/web/http.ts`):
   - `WebWriteRequest` 增加 `reasoningEffort: string | null`；
   - 在 `POST /api/sessions` 接口处解析 `body.reasoningEffort`：实施字符集校验（仅限 `^[a-zA-Z0-9_-]{1,80}$`）并限制长度，非法格式拒绝请求；
   - `dispatchWebOperation` 在调用 `source.create` 时透传 `reasoningEffort`；
   - `CodexWebSource.create` 校验传入的 `reasoningEffort` 是否属于所选模型支持的档位（若有模型声明），若合法则传给 `startThreadAndTurn`。

### 2.4 Web 前端界面与联动交互 (`src/web/public/`)
1. **HTML 结构** (`src/web/public/index.html`):
   在 `#create-dialog` 表单中紧随 `#create-model` 之后添加：
   ```html
   <label id="create-reasoning-label" for="create-reasoning-effort">推理强度</label>
   <select id="create-reasoning-effort">
     <option value="">使用模型默认设置</option>
   </select>
   ```
2. **动态选项联动** (`src/web/public/app.js`):
   - 缓存拉取到的 `models.items`，每当 `#create-source` 或 `#create-model` 改变，或目录加载完成时触发 `syncReasoningEffortControl()`：
     - 若当前所选模型声明了 `supportedReasoningEfforts`，过滤出属于桌面常规视野的档位集合（`['low', 'medium', 'high']`）；
     - 若该集合非空：填充选项（默认项 + 支持的选项），启用下拉框；
     - 若该集合为空（如不支持推理的图像模型或轻量模型）：下拉框仅保留“使用模型默认设置”，并将下拉框设为 `disabled`，避免误导用户；
   - `submitWrite(create)`：从 `#create-reasoning-effort` 读取选中值（非空则上传，空字符串转为 `null`）；
   - `setConnectionControls(disabled)`：将 `create-reasoning-effort` 纳入连接断开/恢复时的禁用/启用列表；
   - `clearSensitive()`：重置 `#create-reasoning-effort` 的子节点为单项默认值。

---

## 3. 安全性与向后兼容

1. **白名单与输入清洗**：
   - 服务端严格限制 `reasoningEffort` 格式与 80 字符长度；
   - 不信任前端传入的任意字符串，未声明推理能力的模型或非法值在底层安全忽略或拦截。
2. **协议与数据容错**：
   - 存量测试中未提供 `supportedReasoningEfforts` 的 Mock 数据，安全降级为空数组，不会触发 TypeError；
   - 旧会话读取与消息入队完全不受影响。
3. **无新运行时依赖**：
   - 纯原生 TypeScript / Bun 运行时与原生 Web DOM 操作，无新增外部依赖。

