# SeaBridge 接入 Antigravity ACP：设计与分阶段实施方案

> 状态：P0–P4 已完成实施与验收（2026-11-09 更新：完成 P0 实测证据、P1–P2 Web MVP、P3 Telegram 全能力接入、P4 `Antigravity` 桌面端与 `agy` CLI 原会话写入互通；P5 ToolHub 独立评估待按需启动；`Antigravity IDE` 暂不纳入范围）。
> 编写日期：2026-11-07；修订日期：2026-11-09。
> 源码基线：SeaBridge `1.2.4`，提交 `d7b2860`。
> 协议与版本基线：本机 `~/.local/bin/agy` `1.5.2`（ACP `protocolVersion: 1`）、`Antigravity.app`（Antigravity 2.0 桌面端）`2.29.0`（另有 `Antigravity IDE.app` `2.5.5` 及其内置调用的 `~/.gemini/bin/agy` `1.5.3`，仅作本机环境背景说明，暂不作为适配目标）。
> 本次授权范围：编写与修订方案文档。此前允许升级 AGY，不等于允许创建业务/测试会话、修改 SeaBridge 产品代码或部署。

## 1. 结论与产品边界

采用 **SeaBridge 作为 ACP Client，启动本机官方 `agy acp` 子进程** 的路线。新增独立的 `antigravity` 来源，不把 Antigravity 包装成 Codex，不逆向桌面私有接口，不模拟点击，不修改原生会话数据库。[R1]

本机存在三个 Antigravity 相关端，本方案的目标范围界定如下：
- **`agy`（Antigravity CLI / ACP，核心纳入）**：终端命令行与 `agy acp` stdio 服务，默认使用 `~/.gemini/antigravity-cli`（`--app-data-dir=antigravity-cli`）；`agy models` 提供只读可用模型列表。
- **`Antigravity`（Antigravity 2.0 桌面 App，`Antigravity.app`，首版纳入只读列表与历史、P4 验证写入互通）**：独立 Electron 桌面端，底层运行内置 `language_server --standalone --subclient_type hub --app_data_dir antigravity`，数据目录为 `~/.gemini/antigravity`（含 `conversation_summaries.db` 与 `brain/<id>/.system_generated/logs/transcript.jsonl`）。
- **`Antigravity IDE`（`Antigravity IDE.app`，暂不考虑）**：首版及近期规划不针对 `Antigravity IDE` 做专门适配，仅在进程清理边界上确保不误杀其后台 `agy --hub` 进程。

第一阶段（P0–P3）交付的是：
1. 在 SeaBridge 中**创建（支持新建前分别选择基础模型与思考等级 `Effort`）、查看、续聊、审批和停止 SeaBridge 自己管理的 Antigravity 会话**；
2. 在 SeaBridge Web 端**只读展示 `Antigravity` 桌面端（`~/.gemini/antigravity`）的会话列表、运行状态与历史消息**（与 Codex 列表体验对齐，不调用有副作用的 `session/load`）。
3. 对 `Antigravity` 桌面端外部原会话的**写入/续聊**默认关闭（`sendEnabled: false`），必须在 P4 单独验证跨进程 SQLite WAL 锁与原会话互通后才按开关开放；不能拿导入副本或传递一段摘要代替原会话互通。

整体顺序：

```text
协议、模型/思考等级映射与桌面只读结构验证（P0）
  → ACP 基础层、模型/思考等级聚合缓存与桌面只读读取器（P1）
  → Web 托管会话闭环 + 新建前选模型/思考等级 + 桌面会话只读展示（P2）
  → Telegram 路由与双端统一审批（P3）
  → Antigravity 桌面端原会话写入互通验证（P4）
  → ToolHub 任务执行能力评估（P5）
```

### 1.1 用户目标与设计假设

已知目标是借鉴 SeaBridge 对 Codex App Server 的接入方式，为 Antigravity 提供一致的使用体验：新建前可分别选择模型与思考等级（`Effort`）、列表中能看到 Antigravity 桌面端会话；同时用户此前明确不接受重复创建会话，以及把内部 JSON 报告格式强加给普通聊天。

本方案据此作以下设计选择，均属于拟议行为，不是现有功能：

- 保留现有 Codex、dsh 的行为和数据语义；新增能力默认关闭。
- 普通聊天保留用户原文和正常 Markdown 回复；传输使用 JSON-RPC 不等于回答必须是 JSON。
- **模型与思考等级分离**：新建会话前通过只读 `agy models`（带缓存）将底层模型变体聚合为**基础模型（Model）**与**思考等级（Effort：`low` / `medium` / `high` 等）**两级独立选项，复用 SeaBridge 现有的 `create-model` 与 `create-reasoning-effort` 双下拉框，并在 `session/new` 后与会话实际 `configOptions` 二次校验。
- Web 会话列表合并展示 **SeaBridge 托管会话（可读写）** 与 **`Antigravity` 桌面端顶层会话（首版只读，`sendEnabled: false`）**；`Antigravity IDE` 暂不考虑。
- 单次新建只创建一个原生会话；续聊必须绑定原 ID，恢复失败不自动改成新建。
- 不确定状态优先阻止重复执行，而不是通过重试、导入或另一种传输“救活”任务。

### 1.2 首版包含与明确不包含

| 首版包含 | 首版不包含 |
| --- | --- |
| 显式开启 Antigravity 来源；本机版本、握手与认证状态展示 | 自动升级 AGY、修改全局权限、替用户登录 |
| 基于 `agy models` 只读探测与家族聚合的新建前**模型 + 思考等级分离选择**（含默认兜底与不可调等级模型自动禁用等级控件）及空闲态切换 | 运行中动态切换模型/思考等级、`Antigravity IDE` 专属适配 |
| 本地允许项目中的托管新会话、原会话续聊、重启恢复 | 首版直接向 `Antigravity` 桌面端外部会话发送/写入消息（留待 P4） |
| `Antigravity` 桌面端（`~/.gemini/antigravity`）顶层会话列表、运行状态与历史消息的纯只读展示 | 通过 `session/load` 偷偷恢复外部桌面会话、批量导入副本会话 |
| 用户与助手消息、工具活动、执行状态、历史分页 | 完整复刻 Antigravity UI、任意图片/音频/附件能力 |
| 经过验证的权限请求处理（Web 审批 + Telegram 共享审批）和精确到桥接执行的停止 | 跨客户端中断、把会话级取消伪装成原生 turn 级取消 |
| 操作幂等、故障隔离、审计、功能开关和回滚 | 首版接入 ToolHub 的检查、验收、提交与合并链路 |

## 2. 已确认事实与尚未确认的能力

### 2.1 本机证据

本次重新执行 `~/.local/bin/agy --version`，返回 `1.5.2`；`agy acp --help` 返回 ACP 专用帮助。此前升级验收保存的真实握手结果为：

```json
{
  "protocolVersion": 1,
  "agentInfo": {
    "name": "Antigravity ACP Server",
    "version": "1.5.2"
  },
  "agentCapabilities": {
    "loadSession": true,
    "promptCapabilities": {
      "image": true,
      "audio": false,
      "embeddedContext": true
    },
    "sessionCapabilities": {
      "resume": {},
      "close": {},
      "load": {},
      "list": {},
      "additionalDirectories": {}
    }
  }
}
```

以上是选取后的字段，不是完整响应。原始证据还含有部分 snake_case 别名和 Antigravity 扩展字段；兼容层只按已保存 fixture 处理，不据此猜测所有字段都存在别名。

本机证据位置，供维护者核验，不应复制凭据或整个配置归档到仓库：

```text
~/.local/state/agy-upgrade-backups/20261107-145819-1.3.3-to-1.5.2/
  acp-verification.json
  acp-response.json
  final-verification.json
```

### 2.2 本机 `agy` 与 `Antigravity` 桌面端运行、模型目录及存储拓扑

2026-11-08 对本机进程、应用包、`agy models` 与 `~/.gemini/` 目录做只读核验后，确认实际运行方式与数据目录关系如下（`Antigravity IDE` 暂不纳入适配目标，仅记录其后台进程形态以供进程隔离参考）：

| 产品端 | 本机位置与版本 | 实际后端进程与启动参数 | 活动数据目录（相对于 `~/.gemini/`） | 会话与配置存储形态 |
| --- | --- | --- | --- | --- |
| **`agy`**<br>（Antigravity CLI / ACP，核心纳入） | `~/.local/bin/agy`<br>版本 `1.5.2` | `agy` / `agy acp`（以及运行期派生的 `agy --bg-updater --app_data_dir=antigravity-cli --gemini_dir=.gemini`） | 默认 `antigravity-cli`<br>（即 `~/.gemini/antigravity-cli`） | `conversations/<id>.db`、`conversation_summaries.db`、`brain/<id>/.system_generated/logs/transcript.jsonl`、`settings.json` |
| **`Antigravity`**<br>（Antigravity 2.0 桌面 App，纳入只读展示与 P4 互通） | `/Applications/Antigravity.app`<br>版本 `2.29.0` | `/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --override_ide_name antigravity --subclient_type hub --override_ide_version 2.29.0 ... --app_data_dir antigravity` | `antigravity`<br>（即 `~/.gemini/antigravity`） | `conversations/<id>.db`（WAL 模式）、`conversation_summaries.db`、`brain/<id>/.system_generated/logs/transcript.jsonl`（及 `transcript_full.jsonl`）、`user_settings.pb` |
| **`Antigravity IDE`**<br>（独立 AI IDE，**暂不考虑**） | `/Applications/Antigravity IDE.app`<br>版本 `2.5.5` | 内置扩展按窗口启动 `~/.gemini/bin/agy --hub --hub-port=<ephemeral> --app_data_dir=antigravity` | `antigravity`<br>（背景事实：与 `Antigravity.app` 共用目录） | 不作为适配对象；仅在清理进程时规避误杀 `agy --hub` |

同时，本机已实测确认以下两项只读能力：

1. **`~/.local/bin/agy models` 只读输出与“模型 + 思考等级（Effort）”分离机制验证通过**：
   - 在 `agy` 交互式 `Switch Model` 界面与 CLI 参数（`--model` 与 `--effort`）中，**基础模型（Model）**与**思考等级（Effort：`low` | `medium` | `high`）**是分开的独立控件：
     - 多档位模型家族（`Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`、`Claude Sonnet 5.5`）可在 `low`、`medium`、`high` 之间独立切换思考等级；
     - 单档位模型（`GPT-OSS 120B (Medium)`）固定为一个等级，在 `agy` 中不可调节思考等级（提示 `Effort isn't adjustable for the current model`）。
   - 执行 `~/.local/bin/agy models` 退出码为 `0`，不创建任何会话文件，按 `<variantId>  <displayName>` 展开返回 13 条底层模型变体，且**同一模型家族在输出中的第一行即为其默认思考等级**（例如 `gemini-4-argon-medium` 排在 `gemini-4-argon` 家族首行，默认等级为 `medium`；`gemini-3.8-flash-high` 排在首行，默认等级为 `high`；`claude-opus-5-5-low` 与 `claude-sonnet-5-5-low` 排在首行，默认等级为 `low`；`gpt-oss-120b-medium` 仅单行）。
   - 注意：标准输出前段带有终端进度转轮控制符（`\r⠋ Fetching available models...`），解析器必须先剥离 ANSI / `\r` 进度前缀，再提取并聚合为 SeaBridge 的 `CatalogItem`（`{ id, name, defaultReasoningEffort, supportedReasoningEfforts }`）。
2. **`Antigravity` 桌面端（`~/.gemini/antigravity`）具备与 Codex 同构的纯只读元数据与 JSONL 轨迹文件**：
   - **会话列表库（`~/.gemini/antigravity/conversation_summaries.db`）**：可以 `file:...?mode=ro` 只读打开，`conversation_summaries` 表包含 `conversation_id`、`title`、`last_modified_time`、`workspace_uris`（JSON 数组，如 `["file:///opt/app/aitools/sea-bridge"]`）、`status`（`CASCADE_RUN_STATUS_RUNNING` / `CASCADE_RUN_STATUS_IDLE`）、`not_fully_idle`、`killed`、`parent_conversation_id`、`nesting_depth`。过滤 `nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0` 即可精确获取桌面端顶层用户会话（排除子代理会话）。
   - **会话消息轨迹（`~/.gemini/antigravity/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`）**：纯文本 JSONL 文件，按行记录 `step_index`、`type`（如 `USER_INPUT`、`PLANNER_RESPONSE`）、`status`、`created_at`、`content`、`tool_calls`、`truncated_fields`（当存在 `truncated_fields` 时按行号读取同目录 `transcript_full.jsonl`）。
   - **关键结论**：SeaBridge 无需对 `Antigravity` 桌面端外部会话调用有副作用的 ACP `session/load`，也无需触碰 `conversations/<id>.db` 写锁，即可在 **P2 首版直接实现 `Antigravity` 桌面端会话列表、运行状态和消息历史的纯只读展示**。

### 2.3 证据等级

| 能力 | 当前证据 | 允许得出的结论 |
| --- | --- | --- |
| 启动 ACP、初始化、关闭测试进程 | 本机真实验证通过 | 可以开展 ACP 适配 |
| `agy models` 只读获取可用模型与思考等级列表 | 本机真实验证通过（返回 13 条变体，可精确聚合为 5 个基础模型与各自支持的 `Effort` 档位，零会话副作用） | **首版（P1/P2）即可提供新建会话前的“模型 + 思考等级”分离下拉选择** |
| `Antigravity` 桌面端 `conversation_summaries.db`（`mode=ro`）与 `transcript.jsonl` 只读读取 | 本机真实验证通过 | **首版（P1/P2）即可在 Web 端只读展示 `Antigravity` 桌面端会话列表与历史** |
| list/load/resume/close | 初始化响应声明支持 | 可以编写能力门控；尚不能宣称业务链路通过 |
| 新建、真实模型回答、连续两轮、审批、中断 | 本次未执行 | 必须在 P0/P2 验证 |
| `agy acp` 对 `Antigravity` 桌面端外部原会话的跨进程写入互通 | 桌面端 `language_server` 正在以 WAL 模式持有 `~/.gemini/antigravity/conversations/*.db`，跨进程并发写尚未验证 | 首版桌面端外部会话在 Web 端设为只读（`sendEnabled: false`），写入互通留待 P4 专项验证 |
| 文件/终端沙箱隔离、ToolHub 监督权限 | 未验证 | 不宣称具备 Codex 等价安全能力 |

官方文档描述的桌面导入会复制历史、上下文和工具轨迹，因此它不能作为“同一条原生会话双向续聊”的证据。[R9]

## 3. SeaBridge 现状、复用边界与 Codex 功能对比

### 3.1 代码模块与复用边界

以下路径相对于仓库根目录，位置以本次源码基线为准。

| 模块 | 当前行为 | 本次设计的处理 |
| --- | --- | --- |
| `src/desktop/codex-app-server-client.ts` | 启动 Codex App Server，握手，管理普通首轮与所有权 | 保留；参考传输防护，不让 ACP 继承 Codex 业务假设 |
| `src/desktop/codex-read-service.ts` | 用只读 RPC 白名单查询会话、历史、项目、模型 | 保留；Antigravity 另建 `desktop-reader.ts` 以只读 SQLite + `transcript.jsonl` 展示桌面会话 |
| `src/desktop/codex-conversation-requests.ts` | 持久新建与原文发送共用，不强制 outputSchema | Antigravity 保持同样的用户体验约束 |
| `src/desktop/codex-queue-client.ts` | 普通续聊走原生 queue；托管任务优先路由 | Antigravity 不复用 Codex queue |
| `src/web/sources/types.ts` | 有 `WebSource`，但来源、元数据和停止范围仍有 Codex 耦合 | 小范围扩展类型，保持现有协议兼容 |
| `src/web/operations.ts` | 持久 claim、幂等摘要、dispatch；异常不自动重发 | 复用入站去重；增加 AGY 的异步执行投影 |
| `src/web/migrations.ts` | `web_operations.source` 有 `codex/dsh` 的 CHECK 约束 | 必须有显式数据库迁移，不能只改 TypeScript |
| `src/telegram/provider-reply-router.ts` | 按被回复消息在 Codex/dsh 间精确路由 | 扩展第三来源，不猜测最新 Antigravity 会话 |
| `src/tasks/runtime.ts`、`src/tasks/codex-runner.ts` | 直接构造 `TaskCodexRunner`，含专用权限和交付守卫 | 首版不改任务执行；后续单独设计能力合同 |

另外，`src/web/http.ts` 的 URL 匹配、`store.ts`、`status.ts`、`runtime.ts`、`operations.ts` 和前端 `app.js` 都有二来源限制。中断与模型修改 HTTP 路由目前仅支持 Codex。接入不是增加一个文件就能完成。

需要保留的既有约束见 [ToolHub 持久任务会话说明](../../ai/2026-11-04-toolhub-task-conversations.md)：不污染真实会话列表，不强制 JSON，不把模型回答等同于检查或验收完成。

### 3.2 与现有 Codex 功能全景对比及对齐策略

将本方案与 SeaBridge 现有 `CodexWebSource`（`src/web/sources/codex.ts`）、Telegram 路由及 ToolHub 任务中心逐项对比，功能对齐情况如下：

| 功能维度 | Codex 现有实现（`CodexWebSource`） | Antigravity 当前方案 | 对齐结论与阶段 |
| --- | --- | --- | --- |
| **1. 新建会话与首轮提问** | `CodexAppServerClient.startThreadAndTurn` 创建持久会话并发送原文，不强制 JSON schema。 | ACP `session/new` + `session/prompt` 创建并发送原文，同样不强制 JSON（第 6.3 节）。 | **一致（P2）** |
| **2. 同会话多轮续聊** | 绑定原 `threadId` 续聊；恢复失败不自动新建。 | 托管会话绑定原 `nativeSessionId`（必要时 `session/load` 或 `session/resume`）发送 `session/prompt`；禁止退回 `--continue` 或隐式新建（第 6.3 节）。 | **一致（P2）** |
| **3. 操作幂等与防重发** | `dispatchWebOperation` 落库 claim，断连标 `delivery_unknown`，绝不自动重发。 | 复用同一套操作账本，并针对 ACP 阻塞式 `session/prompt` 拆出独立异步执行状态表（第 6.4 节）。 | **一致（P1/P2）** |
| **4. 实时工具活动与历史分页** | 解析本地 rollout 文件展示消息、工具耗时与 `activeTurnItems`。 | 托管会话读本地 `session/update` 投影表；`Antigravity` 桌面端外部会话只读解析 `transcript.jsonl`（第 8.1 节）。 | **一致（P2）** |
| **5. 精确停止当前执行** | 校验 `expectedTurnId`（`exact_codex_turn`），防止误停新一轮。 | 校验 `expectedExecutionId + expectedEpoch` 发送 `session/cancel`，取消后回收该 worker 进程以防跨轮污染（第 7.2 节）。 | **一致（P2）** |
| **6. 空闲状态切换模型/思考等级** | 严格校验会话 `idle` 后调用 `updateThreadModel`，并在 `WebSessionMeta` 中分别展示 `model` 与 `reasoningEffort`。 | 仅允许空闲状态调用 ACP `session/set_config_option` 修改模型/思考等级，并在 `WebSessionMeta` 中同样分离展示 `model` 与 `reasoningEffort`（第 8.3 节）。 | **一致（P2）** |
| **7. Telegram 命令菜单、续聊路由与通知** | 提供 `/status`、`/projects`、`/model`、`/new`（菜单与快捷创建）、引用/`💬 回复` 按钮/无引用最新通知路由、`DesktopObserver` 终态推送与 Inline 审批（`dsh` 亦对应提供 `/dsh_status`、`/dsh_projects`、`/dsh_model`、`/dsh_new` 与 `DshSessionObserver`）。 | **在 P3 全量对齐 Codex 与 dsh 的 Telegram 能力**：提供 `/agy_status`、`/agy_projects`、`/agy_model`（含模型 + 思考等级按钮）、`/agy_new`（分页菜单 + 快捷创建 + `ForceReply`）、引用/`💬 回复` 按钮/最新通知路由、托管与桌面端会话终态通知 outbox、以及跨 Web/Telegram 共享审批（第 11.2 节）。 | **一致（P3；外部桌面会话回复留待 P4）** |
| **8. 工具权限审批** | 目前仅支持 Telegram 审批（`approvalTransport: "telegram"`）。 | **P2 先支持 Web 端直接审批，P3 打通 Web + Telegram 共享同一条 pending 记录**（先决者生效，第 9.1 节）。 | **Antigravity 更完整（P2/P3）** |
| **9. 新建页项目、模型与思考等级双下拉列表** | 从 Codex App Server 查询项目列表（`listProjects`）和模型列表（`listModels`），每个模型含 `defaultReasoningEffort` 与 `supportedReasoningEfforts`，前端渲染独立的 `create-model` 与 `create-reasoning-effort` 两个下拉框。 | **在 P2 首版与 Codex 完全对齐**：通过 `agy models` 只读子命令解析并按家族聚合为基础模型（`id`、`name`）与思考等级（`defaultReasoningEffort`、`supportedReasoningEfforts`），直接驱动前端现有的 `create-model`（模型）+ `create-reasoning-effort`（思考等级）双下拉框（单档位模型自动禁用思考等级下拉框）；项目列表来自本地允许目录配置（第 8.2–8.3 节）。 | **一致（P2）** |
| **10. 桌面原会话列表与历史展示** | 默认展示 Codex Desktop 活跃会话与历史。 | **在 P2 首版与 Codex 对齐展示 `Antigravity` 桌面端会话**：通过只读读取 `~/.gemini/antigravity/conversation_summaries.db`（`mode=ro`，顶层会话）与 `brain/<id>/.system_generated/logs/transcript.jsonl`，在 Web 端合并展示桌面端会话列表、运行状态与消息历史（`Antigravity IDE` 暂不考虑，第 8.1、8.4 节）。 | **列表与历史只读一致（P2）；外部会话写入留待 P4** |
| **11. 运行中继续发消息（Queue）** | 支持原生队列（`ProcessCodexQueueClient`）并在历史中展示 `queuedMessages`。 | **首版不支持运行中排队**。单会话最多 1 个在途 prompt，运行中再次发送直接返回 `session_busy`（第 7.1 节）。 | **不一致（首版裁剪）** |
| **12. 图片附件读取（`attachment`）** | 支持按 `messageId + index` 从原生记录读取用户图片附件。 | 首版明确不包含图片/音频/附件能力（第 1.2 节）。 | **不一致（首版裁剪）** |
| **13. ToolHub 受监督任务执行** | 已接入 `TaskCodexRunner`（专用沙箱、只读守卫、`run/tasks.sock`）。 | 首版不接入；留待 **P5** 独立验证沙箱、Git/网络限制与交付守卫后再评估（第 11.3 节）。 | **不一致（延后至 P5）** |

**主要边界与设计取舍说明：**

1. **`Antigravity` 桌面端会话“P2 只读展示、P4 验证写入”**：本机已证实 `~/.gemini/antigravity/conversation_summaries.db` 与 `brain/<id>/.system_generated/logs/transcript.jsonl` 可安全只读读取，因此 P2 直接提供桌面端会话列表与历史查看；但对桌面端原会话发起续聊需跨进程写入 `conversations/<id>.db`，在 P4 验证与桌面端 `language_server` 的 WAL 锁兼容性前，外部桌面会话在 Web 端保持 `sendEnabled: false`。
2. **`agy models` 预加载、模型/思考等级分离聚合 + `session/new` 二次校验**：本机 `agy models` 已实测无副作用返回 13 条变体，按模型家族聚合后可精确生成 5 个基础模型（`Gemini 4 Argon`、`Gemini 3.8 Flash`、`Claude Opus 5.5`、`Claude Sonnet 5.5`、`GPT-OSS 120B (Medium)`）及其各自的 `defaultReasoningEffort` 与 `supportedReasoningEfforts`，与 `agy` TUI 的 `Switch Model` + `Effort` 滑块及 SeaBridge 前端现有的双下拉控件完全一致；创建会话后通过 `session/set_config_option` 应用所选模型与思考等级，既对齐 Codex 体验又避免创建探测空会话。
3. **运行中不排队**：ACP 的 `session/prompt` 是单会话串行 turn 模型。首版返回 `session_busy` 可避免在 SeaBridge 内存中积压未发送原文。

## 4. 路线选择与技术决策

| 路线 | 优点 | 代价与边界 | 结论 |
| --- | --- | --- | --- |
| 官方 ACP | 双向协议，提供会话与权限交互 | 需实现事件、恢复、生命周期与审批适配 | 正式主路线 |
| CLI headless stream-json | 适合脚本执行与流式输出 | 不是 ACP；双向控制能力不能直接等同，故障切换可能重复执行 | 首版不实现，不作为自动降级 |
| 私有语言服务或桌面 UI 自动化 | 可能触达更多内部行为 | 版本耦合、所有权和安全语义难验证 | 不选 |

Headless 的限制以官方说明为依据。[R10] AGY 已升级，不再为了兼容 `1.3.3` 同时维护两套写入通道。

传输层首版使用项目现有 Bun/Node 能力和严格运行时校验，不新增依赖。若后续决定采用官方 ACP SDK，应单独评估并获得依赖引入授权；不能在实施时静默安装。

## 5. 目标架构

```text
Web / Telegram                              ToolHub（后续）
       │                                          │
       └──────── SeaBridge 来源路由 / 操作账本 ────┘
                              │
                  AntigravityWebSource / ReplyRouter
                  ├─ ModelCatalog（`agy models` 只读预加载 + 缓存）
                  ├─ DesktopSessionReader（`~/.gemini/antigravity` 只读 SQLite + JSONL）
                  └─ AntigravitySessionManager（托管会话读写闭环）
                     ├─ 持久会话 / 执行 / 消息投影
                     ├─ 审批桥接 / 取消屏障
                     └─ 项目策略 / 能力门控
                              │
                       AcpClient / Transport
                              │ stdio JSON-RPC
                    ~/.local/bin/agy acp
                              │
                   原生 Antigravity Agent
```

### 5.1 模块边界

拟新增 `src/antigravity/`，其中 transport 只处理协议帧；client 处理 ACP 方法；model-catalog 负责 `agy models` 只读预加载与缓存；desktop-reader 以只读方式（`mode=ro`）读取 `Antigravity` 桌面端的 `conversation_summaries.db` 与 `brain/<id>/.system_generated/logs/transcript.jsonl`；session-manager 管托管会话生命周期；store 保存服务自有状态；projection 生成前端消息；approval-bridge 处理权限请求；policy 校验本机执行范围。

`AntigravityWebSource` 把上述能力转成 `WebSource`：对原生桌面数据库严格只读（`mode=ro`）且不修改任何原生文件，不执行任意 shell。来源 ID 统一使用 `antigravity`，`agy` 只用于可执行文件名。

首版采用一个受控 worker 对应一个活动托管会话，默认最多一个活动执行。不同来源相互隔离；实际资源预算在 P0 测量后才能调高。`Antigravity` 桌面端外部会话的列表与历史展示直接走 `desktop-reader` 只读路径，不在这个阶段对外部桌面会话调用 `session/load` 或 `session/resume`。

这是一项桥接端的进程隔离策略，不是对 Antigravity 原生跨客户端单写者保证的断言。`--process-per-session` 虽在本机帮助中存在，首版不依赖其内部 worker 语义。

### 5.2 实施原则

先落持久意图，再向原生进程发送；使用 argv 启动而非 shell 拼接；每个子进程有身份、启动时间和 generation；关闭、取消和清理都只作用于本服务创建并能确认身份的进程（校验具体子进程 PID、启动时间及 `agy acp` 启动参数，严禁按进程名 `agy` 或 `language_server` 宽泛匹配，以免误伤 `Antigravity IDE` 的 `agy --hub`、CLI 的 `agy --bg-updater` 或 `Antigravity.app` 的 `language_server`）。

前端仅看到来源、会话、执行和能力，不接触本地凭据、管道或进程管理细节。一个来源异常不能让 Codex/dsh 整体不可用。

## 6. ACP 合同与生命周期

### 6.1 初始化与认证

启动命令使用配置好的绝对路径，基本形态为 `agy acp --gemini-dir=<path> --app-data-dir=<dir>`；是否附加 `--sandbox` 由经 P0 验证的服务端安全配置决定。生产默认要求该安全配置通过验证，不允许静默去掉沙箱以绕过启动失败。

- **数据目录参数显式化**：首版（P0–P3）显式传入受控的 `--app-data-dir`（默认 `antigravity-cli` 或 SeaBridge 专用隔离目录，由 `SEA_BRIDGE_ANTIGRAVITY_APP_DATA_DIR` 控制），绝不隐式指向 `Antigravity.app` 与 `Antigravity IDE.app` 正在共用的 `antigravity` 目录。
- **IDE 宿主参数约束**：在 SeaBridge 无头模式下保持 `--ide-mcp-port=0`（默认关闭），不伪造 IDE 宿主 MCP 端口。
- **可执行文件版本固定**：明确绑定经校验的 `agy` 路径（如 `~/.local/bin/agy` `1.5.2`），不因 PATH 顺序变化而静默切换到 `Antigravity IDE` 管理的 `~/.gemini/bin/agy`（`1.5.3`）。

发送 `initialize(protocolVersion: 1)`，仅声明真实实现的 client capabilities。首版不提供客户端文件系统、终端、任意 MCP 或交互式认证能力；这些能力不声明为 true。初始化成功后按 ACP v1 继续，不复制 Codex 的 `initialized` 通知流程。[R3]

注意：不声明 client fs/terminal，不代表 Agent 自己不能读写文件或运行工具；真正权限必须由 AGY 策略及经过验证的沙箱承担。初始化也不证明登录有效（且 `antigravity-cli` 与 `antigravity` 目录各自维护独立配置文件与认证状态）。认证失败时显示本机重新登录提示，不自动拉起 OAuth，不读出 token，也不改用另一个账号或模型。

Agent 返回不支持的协议版本时直接标记 `protocol_incompatible`。版本号、二进制摘要或有效权限配置变化后，重新执行能力合同验证；网页轮询不得触发升级或登录。

### 6.2 方法映射

| 操作 | ACP 方法 | SeaBridge 规则 |
| --- | --- | --- |
| 新建 | `session/new` | 使用服务端确认的绝对 cwd；首版 `mcpServers: []` |
| 带历史恢复 | `session/load` | 仅在支持 load 且通过恢复门槛后使用；回放阶段单独处理 |
| 无历史恢复 | `session/resume` | 仅在声明支持时使用；本地历史完整性另行判断 |
| 列表 | `session/list` | 能力门控、分页、项目过滤；不是运行状态查询 |
| 发消息 | `session/prompt` | 保持用户原文，不注入报告格式 |
| 接收内容 | `session/update` | 校验 sessionId、连接代次与当前阶段 |
| 权限请求 | `session/request_permission` | 反向 RPC，必须返回真实 optionId 或 cancelled |
| 修改模型/参数 | `session/set_config_option` | 只使用当前会话实际返回的选项和值 |
| 停止 | `session/cancel` | 会话级通知；由桥接端执行代次限制作用对象 |
| 释放 | `session/close` | 能力门控；首版只主动释放已确认终态的会话 |

会话方法、配置项、提示轮次与权限响应的协议来源分别见 [R4]、[R6]、[R7]、[R8]。上述方法的本机业务行为仍须实测，不凭名称推断。

### 6.3 新建与续聊

新建流程：

```text
认证与项目校验
 → 持久化 operationId 和请求摘要（含独立的 modelId 与 reasoningEffort）
 → 创建一次 session/new
 → 立即持久化 nativeSessionId，并向操作账本发布映射
 → 校验实际返回的配置；需要时设置所选模型与思考等级（Effort）
 → 记录待发送执行身份
 → 发送一次 session/prompt
 → 聚合更新并等待该请求的最终结果
```

`session/new` 成功但首轮失败时保留已知会话 ID，展示“会话已创建，首轮未完成”，不能重新创建。创建请求发出后丢失响应时进入不确定状态，不按“最新会话”猜测 ID，也不自动再次创建。

续聊只使用保存的 `nativeSessionId` 和绑定的项目根。会话不存在、目录不匹配、权限变化或被外部持有时，返回明确错误；禁止用 `--continue`、导入副本或 new 代替。跨 worktree 改变 cwd 不作为首版能力。

### 6.4 请求超时与 HTTP 生命周期

ACP 的 `session/prompt` 响应代表该轮结束，不是 Codex `turn/start` 式的启动确认。[R7] 因此不能让 Web 请求一直等模型完成，也不能在写入 stdin 后立即标成“来源已接受”。

保留现有 `web_operations` 的投递状态词汇，另建执行状态：

| 证据 | 投递投影 | 执行投影 |
| --- | --- | --- |
| 持久化成功、尚未发给 Agent | `queued` | `queued` |
| 已跨过发送边界，但没有可靠执行证据 | 保持待确认说明 | `starting` |
| 当前执行的有效内容/工具/审批事件，或最终响应 | `accepted` | `running` 或终态 |
| 有效 `stopReason: end_turn` | `accepted` | `completed`，仅表示该轮结束 |
| `cancelled` | 已确认时保持 `accepted` | `cancelled` |
| `max_tokens` / `max_turn_requests` / `refusal` | 已确认时保持 `accepted` | `incomplete`，展示实际原因 |
| 发送后断连，不能确认原生处理情况 | 未确认投递时为 `delivery_unknown` | `unknown` |

元数据、模型菜单、历史回放、管道写入成功和进程退出 `0` 都不单独证明开始或完成。已经有 accepted 证据的操作不因后续断连被改写为“从未接受”，但执行结果仍可为 unknown。

实现需避免后台执行结果被迟到的 `queued` 覆盖，并解决现有 `WebStore` 状态机（`src/web/store.ts`）不允许从 `queued` 推进到 `accepted` 的限制：
1. **新建会话先同步完成控制面握手**：`source.create` 在 `dispatching` 阶段内先同步执行耗极短的 `session/new`（及必要的 `session/set_config_option`），立即调用 `onSessionKnown(sessionId)` 落库 `session_id`，再将长耗时的 `session/prompt` 投入会话 actor 异步执行并返回 `queued`（`turnId` 字段保存本次 `executionId`）。
2. **显式开放受控的 `queued` 二阶段推进**：在 `WebStore` 中新增仅允许 `queued -> accepted | failed | delivery_unknown` 的条件转换方法（`transitionQueuedOperation`），当后台执行器收到首个有效 `session/update`（内容/工具/审批）或 `session/prompt` 终态响应时，将 `web_operations.state` 从 `queued` 推进为 `accepted`（从而使 `listAcceptedMessageSnapshots` 正常展示用户消息快照）；若未收到任何执行证据即断连，则推进为 `delivery_unknown`。该扩展不改变 Codex 与 dsh 的既有同步返回语义。

建议初始参数：控制 RPC 15 秒；审批等待 5 分钟；长 prompt 不套用控制 RPC 超时。安静期间可以标记“暂未收到更新”，但不能因为没有输出就自动杀进程、重发或宣布任务结束。这些是拟议默认值，需要 P0 调整。

## 7. 身份、所有权与取消竞态

### 7.1 三层身份

| 字段 | 意义 |
| --- | --- |
| `sessionId` | SeaBridge 对外的稳定会话引用，统一使用经格式校验（UUID 或安全标识符）的 `nativeSessionId`，确保托管会话与 `Antigravity` 桌面端只读会话处于同一 ID 命名空间且可精确去重 |
| `nativeSessionId` | ACP `session/new` 返回或桌面端 `conversation_summaries.db` 记录的原生会话 ID；校验前不用作文件路径拼接 |
| `executionId + epoch` | SeaBridge 自有的单次执行 ID 和代次；不是原生 turnId |

**托管会话与桌面端只读会话的归属与去重规则**：
- 若某 `sessionId` 已登记在 `antigravity_sessions`（SeaBridge 托管会话），则其列表状态、历史和写入控制均走托管会话路径，并标记 `creationClient: { kind: "sea_bridge", evidence: "explicit" }`；
- 若某 `sessionId` 仅存在于 `desktop-reader`（`~/.gemini/antigravity/conversation_summaries.db`），则作为桌面端外部会话展示，标记 `creationClient: { kind: "desktop", evidence: "explicit" }` 且在 P4 开放前 `sendEnabled: false`；
- 合并列表按 `sessionId` 去重（托管记录优先），绝不在列表或历史路由中让同一 `nativeSessionId` 出现两条记录。

每条执行再记录 `operationId`、`processGeneration`、`rpcRequestId` 和项目策略摘要。关联键包括来源和实例身份，不按标题、最近消息或目录相似度路由。

首版一个托管会话最多一个在途 prompt。再次发送的产品行为为明确返回 `session_busy`，不引入多轮并发或无限队列。相同 operationId 的重复请求仍返回原记录；同 ID 内容不同返回冲突。

本地互斥只能防止 SeaBridge 自己的并发，不能排除外部 CLI/App 对同一原生会话的写入。外部控制能力必须单独验证，不将本地锁描述为原生 writer ownership。

### 7.2 停止必须绑定点击时的执行

新增 AGY 停止接口时使用 `expectedExecutionId` 和 `expectedEpoch`，不要把桥接 ID 塞进 Codex 的 `expectedTurnId`。

停止流程：

1. 会话 actor 内串行校验执行 ID、代次、所属 worker 和非终态。
2. 已结束则返回 already_finished；不是当前执行则返回 active_execution_changed，绝不重新挑一个当前执行。
3. 持久化 cancelling；将该执行尚未完成的权限请求回复 cancelled；发送 `session/cancel`。
4. 等待原 prompt 的终态；期间不得发送下一轮。取消通知本身不是成功回执。
5. 发送过取消的 worker 在这一轮结算后退出，不在原连接上紧接着启动下一轮；下一轮必须在已确认旧执行停止后，以新 generation 恢复同一个原生会话。

第 5 步是首版保守策略，用于降低迟到取消波及下一轮的风险；仍须真实竞态测试，不能只依赖代码推理。若无法确认停止或子进程清理结果，则保持 unknown，禁止自动恢复写入。不得 kill 全局 AGY/App/IDE 进程（如 `Antigravity.app` 的 `language_server`、`Antigravity IDE` 的 `~/.gemini/bin/agy --hub` 或 CLI 的 `agy --bg-updater`）。

ACP 的取消期间权限响应及可选请求取消机制见 [R11]；不要把可选 `$/cancel_request` 当成本机已经验证的精确中断能力。

## 8. 历史、项目、模型与桌面端会话展示/互通

### 8.1 读取不应偷偷恢复会话（托管投影 + 桌面端纯只读读取）

ACP `session/load` 会恢复上下文并回放历史，不应视为 Codex `thread/read` 的只读替代。[R4] 因此，首版普通列表和历史 GET 按会话归属分为两条无副作用只读路径，**绝不为读取列表或历史而对外部会话调用 `session/load`**：

1. **SeaBridge 托管会话**：列表与历史直接从 SeaBridge 本地 `antigravity_sessions` 及 `antigravity_messages` 投影表返回。
2. **`Antigravity` 桌面端外部会话（`~/.gemini/antigravity`，首版纳入只读展示）**：
   - **列表读取**：通过 `desktop-reader` 以 `file:~/.gemini/antigravity/conversation_summaries.db?mode=ro` 只读查询 `conversation_summaries` 表，过滤 `nesting_depth = 0 AND parent_conversation_id = '' AND killed = 0`（排除子代理与已终止后台任务），映射 `conversation_id`、`title`、`last_modified_time`、运行状态（`status = 'CASCADE_RUN_STATUS_RUNNING'` 或 `not_fully_idle = 1` 映射为 `running`，`CASCADE_RUN_STATUS_IDLE` 映射为 `idle`）及工作区路径（解析 `workspace_uris` JSON 数组中的 `file://` URI 并与允许项目根比对）。
   - **历史读取**：只读读取 `~/.gemini/antigravity/brain/<conversation_id>/.system_generated/logs/transcript.jsonl`（校验 realpath 必须位于 `~/.gemini/antigravity/brain/` 下且 `<conversation_id>` 为合法 UUID），将 `USER_INPUT` 与 `PLANNER_RESPONSE` 步骤投影为 `WebMessage` 及工具摘要；当某行存在 `truncated_fields` 时，按对应 `step_index`/行号回退读取同目录 `transcript_full.jsonl`。
   - **只读保护**：在 P4 验证跨进程写入安全并开启 `SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED` 前，桌面端外部会话在 Web 端标记 `sendEnabled: false`，不接受 `send`、`interrupt` 或 `updateModel` 请求。

对 SeaBridge 已管理的托管会话，需要恢复时由独立的恢复动作在会话锁内执行，暂停 prompt。明确区分 `replaying` 与 `live`：回放不推送 Telegram 新消息、不生成新的执行、不把旧工具事件当作本轮进度。

有稳定原生 messageId 时按 ID 聚合。没有时，按一次完整回放生成新历史快照，成功后原子切换，不能简单追加旧历史或按文本哈希去重；两条相同的“好的”可能是真实的不同消息。回放中断保留旧快照，并标记历史不完整。`completeUserHistoryReadable` 必须有证据才为 true。

不默认保存或展示 `agent_thought_chunk`；工具事件转为有界摘要，最终聊天内容与工具日志分开。未知事件不当作完成证据；影响身份或终态的未知结构应停止写入能力并报告协议不兼容。

### 8.2 项目目录

不假设 ACP 存在 Codex 的 `project/list` 或 `projectId`。首版项目来自服务端维护的 Antigravity 允许目录，存储本地项目 ID、显示名和 realpath。浏览器只提交本地项目 ID，不能提供任意 cwd、附加目录、MCP 命令或启动参数。

本地项目绑定是 SeaBridge 的管理信息，不代表原生 App 中已创建或绑定同名项目。目录白名单只约束会话入口，不自动构成文件访问沙箱。

展示 `Antigravity` 桌面端只读会话时，解析 `conversation_summaries.workspace_uris` 中的路径：若匹配已配置的允许项目根则关联对应本地 `projectId`；未配置项目过滤或属于允许展示范围的桌面会话按只读会话展示，不因此放宽新建会话的目录白名单。[R5]

### 8.3 模型与思考等级分离（`agy models` 家族聚合预加载 + 会话内切换）

在 `agy` 交互式 `Switch Model` 界面与 SeaBridge 现有前端（`src/web/public/app.js` 及 `src/web/sources/types.ts`）中，**模型（Model / `modelId`）**与**思考等级（Effort / `reasoningEffort`）**均为两个独立的控件与字段：
- `CatalogItem` 定义为 `{ id, name, defaultReasoningEffort, supportedReasoningEfforts }`；
- 前端渲染独立的 `create-model`（模型下拉框）与 `create-reasoning-effort`（思考等级下拉框），提交 `POST /api/sessions` 时分别传递 `modelId` 与 `reasoningEffort`；
- 会话详情 `WebSessionMeta` 亦分离展示 `model: { id, displayName }` 与 `reasoningEffort`。

因此，首版不把 `agy models` 输出的 13 条带等级后缀的底层变体直接平铺给前端，而是按以下规则实现**模型与思考等级分离**：

1. **新建前“模型 + 思考等级”聚合目录（`models()`）**：
   - `model-catalog` 使用固定绝对路径执行 `agy models`（设置超时与输出大小上限，不经 shell），先剥离标准输出中的 ANSI 控制序列与 `\r` 进度转轮前缀（如 `\r⠋ Fetching available models...`），提取 `<variantId>\s{2,}<displayName>` 列表后按模型家族聚合：
     - **多档位可调模型家族**（同一基础前缀存在多个 `-(low|medium|high|xhigh|max)` 变体，对应本机的 `gemini-4-argon`、`gemini-3.8-flash`、`claude-opus-5-5`、`claude-sonnet-5-5`）：聚合为单个 `CatalogItem`：
       - `id`：剥离等级后缀后的基础模型 ID（如 `gemini-4-argon`）；
       - `name`：剥离末尾 ` (Low|Medium|High|...)` 后的基础显示名（如 `Gemini 4 Argon`）；
       - `supportedReasoningEfforts`：该模型实际支持的等级数组（如 `["low", "medium", "high"]`）；
       - `defaultReasoningEffort`：取 `agy models` 中该家族首行对应的默认等级（与 `agy` 默认档位一致，如 `gemini-4-argon` 为 `"medium"`，`gemini-3.8-flash` 为 `"high"`，`claude-opus-5-5` / `claude-sonnet-5-5` 为 `"low"`）。
     - **单档位不可调模型**（仅存在唯一变体行，如 `gpt-oss-120b-medium` → `GPT-OSS 120B (Medium)`）：保留为独立 `CatalogItem`（`id: "gpt-oss-120b-medium"`，`name: "GPT-OSS 120B (Medium)"`），不返回可切换的多档 `supportedReasoningEfforts`；SeaBridge 前端现有的 `syncReasoningEffortControl()` 会自动禁用思考等级下拉框（与 `agy` TUI 提示 `Effort isn't adjustable for the current model` 行为完全一致）。
     - **内部双向映射表**：`model-catalog` 同时在服务端维护 `(baseModelId, reasoningEffort) <-> rawVariantId`（如 `("gemini-4-argon", "high") <-> "gemini-4-argon-high"`）映射，供协议层调用与元数据反解使用。
   - 前端新建页保留“使用 Antigravity 默认模型”作为兜底选项；即使 `agy models` 暂时不可用，仍允许以默认配置创建会话。
2. **创建与空闲态切换的协议校验及映射**：
   - 在 P0 实测确认 `agy acp` 的 `session/new` 返回的 `configOptions` 具体结构（是暴露独立的 `model` 与 `thought_level`/`effort` 两个配置项，还是以 `<baseModelId>-<effort>` 组合值作为 `model` 配置项枚举）。
   - 在 `session/new` 成功后，`session-manager` 将用户提交的 `(modelId, reasoningEffort)` 与当前会话实际返回的 `configOptions` 校验并映射，调用 `session/set_config_option` 完成模型与思考等级设置，再发送首轮 `session/prompt`；同时在投影 `WebSessionMeta` 时将当前生效配置反解为独立的 `model: { id, displayName }` 与 `reasoningEffort`。[R2][R6]
   - 若所选模型或思考等级组合在当前会话 `configOptions` 中已失效，则停在同一已创建会话（不重新创建第二个会话、不静默换模型/等级）并返回明确错误提示用户重新选择。
3. **运行期与缓存隔离**：
   - 首版只允许空闲状态修改模型或思考等级；虽然协议允许更宽的时机，本产品暂不开放运行中切换。缓存按账号环境、版本、策略和项目隔离，不能把上一账号的选项当作当前可用。

### 8.4 `Antigravity` 桌面端与 `agy` CLI 原会话写入互通验收（`Antigravity IDE` 暂不纳入）

P2 已通过 `desktop-reader` 实现 `Antigravity` 桌面端会话的**只读列表与历史展示**。对于跨端**原会话写入/双向续聊**，聚焦测试 **`Antigravity`（2.0 桌面 App，`Antigravity.app`）** 与 **`agy` CLI**（**`Antigravity IDE` 暂不考虑**），按以下维度在 P4 独立验收：

1. **目录与版本维度**：
   - **CLI 会话目录（`--app-data-dir=antigravity-cli`）**：验证 SeaBridge 启动的 `agy acp` 与终端 `agy --conversation <id>` 之间的同 ID 互通与并发锁行为。
   - **桌面端目录（`--app-data-dir=antigravity`）**：`Antigravity.app`（`2.29.0`，`language_server --subclient_type hub`）使用 `~/.gemini/antigravity`。P4 必须单独验证 `agy acp` 指向 `--app-data-dir=antigravity` 时，与正在运行的桌面端 `language_server` 共享 `conversation_summaries.db` 和 `conversations/<id>.db`（WAL 模式）是否会出现 schema 不兼容、WAL 锁冲突或状态索引损坏。
2. **原生会话写入互通四项判据**（记录会话 ID、存储目录、双方历史及原生运行状态）：
   - SeaBridge 创建后，目标端（`agy` CLI / `Antigravity.app`）是否能直接打开同一 `nativeSessionId` 会话，且不产生导入副本。
   - 在已空闲的桌面端原会话上由 SeaBridge 续聊后，桌面端能否看到新增消息；反向续聊后是否仍保持同一 `nativeSessionId`。
   - 桌面端运行中（`CASCADE_RUN_STATUS_RUNNING` / `not_fully_idle = 1` 或持有 `<id>.db-wal` 写锁）时，另一端是否拒绝写入、排队或允许并发；结果不明或存在写坏风险时保持禁用外部会话写入。
   - 重启、关闭和取消之后，同 ID 的上下文、历史与权限是否保持。

结果按 **`agy` CLI** 与 **`Antigravity`（桌面 2.0）** 分别归类为“原会话互通”“仅只读展示（不可跨端写）”或“仅可导入副本”。“仅可导入副本”不算通过写入互通，首版不自动开放导入按钮。[R9]

## 9. 审批与执行安全

### 9.1 审批协议

反向请求绑定 `source + nativeSessionId + executionId + epoch + processGeneration + rpcRequestId`。向用户展示实际工具类型、命令、路径、范围及选项；工具提供的标题视为不可信文本，不作为自动批准依据。[R8]

首版只提供当前请求确实给出的“一次允许/一次拒绝”。返回服务端提供的原始 optionId，不硬编码 accept/decline；“总是允许”不作为默认能力。选项缺失或无法安全映射时停止该执行，不猜测同意。

审批只能被领取并回复一次。旧代次、过期按钮、取消后按钮、已撤销设备和不匹配用户的点击均不能产生允许结果。审批超时或通道不可用时取消对应执行，并结清 pending 请求，不能自动允许或无限悬挂。

先完成后端审批管理和受认证的 Web 审批；Telegram 接入后，两端共享同一条 pending 记录，先成功的决策生效。不要让同一个请求在两个通道各自拥有独立有效状态。

### 9.2 既有权限规则与沙箱

官方说明既有允许/拒绝规则仍生效，部分操作不会再次询问。[R2] 因此不能声称“所有操作都必经 SeaBridge 审批”。P0 必须检查受控 AGY 环境中实际生效的权限、插件、技能和 MCP 行为。

生产要求：不使用 `--dangerously-skip-permissions`；不继承未审查的全局自动允许策略；不把设置 client fs=false 当作只读权限；不因传入 `mcpServers: []` 就认定全局 MCP 已禁用。

优先验证会话专用数据/设置目录及 `--sandbox` 的真实行为；发现无法建立可说明的权限边界时，停止开放写入，而不是修改全局配置或降低要求。ToolHub 所需的无网络、Git 元数据只读、review 只读等限制需另行证明。

### 9.3 凭据、路径与输出

凭据留在本机，不写入消息、URL、测试 fixture 或审计。只给子进程提供必要环境变量；不把 SeaBridge 的 Telegram token 等无关凭据传给 AGY。日志脱敏不能依赖先读出所有用户秘密。

对项目路径做 realpath、符号链接和允许根验证；拒绝 NUL、路径穿越和任意 MCP/命令参数。`additionalDirectories` 首版为空。原生配置中的符号链接技能能否加载需要验证，不为兼容它们扩大到整个用户目录。

流式数据、工具输出、错误和历史都有大小上限；HTML/Markdown 经现有安全渲染，禁止任意远程图片或文件 URI 自动读取。原始协议录制仅用于显式诊断，必须脱敏、限期清理且放在私有目录。

## 10. 持久化、幂等与重启恢复

### 10.1 服务自有数据

| 拟新增表 | 关键内容 |
| --- | --- |
| `antigravity_projects` | 本地项目 ID、允许根、显示名、策略版本 |
| `antigravity_sessions` | 本地/原生 ID、来源实例、项目绑定、发现方式、历史完整性 |
| `antigravity_executions` | operationId 唯一键、executionId、epoch、generation、RPC ID、状态和终态证据 |
| `antigravity_messages` | 消息、工具摘要、序号、快照代次和回放标记 |
| `antigravity_approvals` | 请求绑定、选项、有效期、已决状态；不保存凭据 |
| `antigravity_message_links` | Telegram chat/message 到来源会话（区分托管可写与桌面只读）的精确映射 |
| `antigravity_telegram_state` | Telegram 按 chat 保存的默认 `(modelId, reasoningEffort)` 偏好、一次性菜单 callback token（含 TTL）、`/agy_new` 待输入 `ForceReply` 状态及桌面会话观察器 baseline 游标 |
| `antigravity_outbox` | 通知去重键、发送状态及重试信息 |

这些表使用 SeaBridge 自己的数据库，不向 AGY 私有库写入。聊天数据采用现有存储脱敏规则；用于尚未发送任务的原文不得借用展示快照恢复。若不实现安全的原文持久队列，则重启后尚未发送的任务明确失败并提示重新提交，而不是发送被脱敏的文本。

首版选择后一种：原文只在执行队列内存中短暂保存，持久化摘要与展示快照；重启时可以明确证明未跨发送边界的待发送任务转为 `not_dispatched_after_restart`。已经跨边界的任务保留 unknown，不自动重发。

### 10.2 数据库迁移与初始化生命周期不能分裂

注意 `src/main.ts` 中 `new StateDb(config.dbPath)` 与 `new TelegramService(...)` 在进程启动最开始即执行，而 `migrateWeb(db)`（`src/web/migrations.ts`）仅在启用 Web 服务并调用 `WebRuntime.start()` 时才执行。因此迁移必须按职责拆分为两处，避免仅启用 Telegram 时因缺表崩溃：

1. **核心状态库迁移（`src/state/db.ts`）**：参照现有 `migrateDshBridgeTables(db)` 模式，新增 `migrateAntigravityBridgeTables(db)`，在 `StateDb` 初始化时创建全部 `antigravity_*` 表与索引。
2. **Web 操作表迁移（`src/web/migrations.ts`）**：增加新的显式迁移版本（`version = 3`），把 `web_operations.source` 允许值扩展到 `codex/dsh/antigravity`。SQLite 现有 CHECK 约束按建新表/迁移数据/原子重命名流程调整；不得修改旧迁移文本后假定已部署数据库会变化。

迁移前记录并备份所有受影响表、索引及外键；迁移必须原子化，处理 `web_message_snapshots` 的父表引用。用真实旧版数据库 fixture 验证操作 ID、状态、消息快照、索引和外键均保留，并执行 `PRAGMA foreign_key_check` 和 `PRAGMA integrity_check`。故障注入要证明可回滚。

新增执行状态放在 AGY 自有表，不把 running/completed 强塞进现有只表示投递的 `OperationState`。

### 10.3 不宣称 exactly-once

入站 operationId 可阻止本服务重复 dispatch，但不能凭 JSON-RPC 请求 ID 推断 AGY 有持久幂等键。发送成功后本地落库失败、连接断开或服务崩溃时，只能保守保存“可能已执行”。

恢复时先确认旧实例和 worker 是否仍在运行，再判断是否允许 load/resume。PID 不存在不证明工具副作用没有发生；会话历史有相同文本也不证明它就是本次 execution 的完成回执。证据不足时显示需要核对，不提供自动重试。

原生会话 ID 已知时，后续恢复始终使用同 ID；ID 未知时保留诊断，不用 session/list 的最近项自动补配。

## 11. Web、Telegram 和任务中心接入

### 11.1 Web

将来源联合类型集中为 `codex | dsh | antigravity`，统一合法值验证，更新来源选择、状态卡片、会话过滤（含 `src/web/session-list.ts` 中允许 `antigravity` 使用 `creationClient` 过滤 `sea_bridge` 托管与 `desktop` 桌面只读会话）、操作诊断记录（`src/web/records.ts` 纳入 `antigravity` 会话标题与 Telegram 投递记录）、历史/发送路由与前端本地选择恢复。禁用功能时不启动 AGY，不触发登录，不创建会话。

明确扩展或新增以下 Web HTTP 路由契约（`src/web/http.ts`）：
1. **目录与历史**：`GET /api/sources/(codex|dsh|antigravity)/(projects|models)`、`GET /api/sessions/(codex|dsh|antigravity)/:id/history`、`POST /api/sessions/(codex|dsh|antigravity)/:id/messages`。
2. **空闲态修改模型与思考等级**：将 `POST /api/sessions/codex/:id/model` 扩展为 `POST /api/sessions/(codex|antigravity)/:id/model`，请求体与 `WebSource.updateModel(sessionId, modelId, reasoningEffort?)` 支持传入可选 `reasoningEffort`（当切换多档位模型或调整思考等级时一并校验并调用 `session/set_config_option`）。
3. **精确停止当前执行**：将 `POST /api/sessions/codex/:id/interrupt` 扩展为 `POST /api/sessions/(codex|antigravity)/:id/interrupt`（或提供 `source.interruptExecution`），对 `antigravity` 校验 `{ expectedExecutionId, expectedEpoch }`；同时保留 Codex 的 `activeTurnId/expectedTurnId/exact_codex_turn` 语义。
4. **Web 端工具权限审批**：新增 `POST /api/sessions/antigravity/:id/approvals/:approvalId`（请求体 `{ optionId: string }`），复用现有登录、设备撤销、Origin/CSRF 校验和审计；返回正文、路径和错误经过脱敏。同步扩展 `src/web/sources/types.ts` 中 `WebSourceCapabilities.approvalTransport`（如 `"telegram" | "web" | "web_and_telegram" | null`），使 P2（Web 审批）与 P3（Web + Telegram 共享 pending 审批）具备精确类型表达且兼容现有 `codex/dsh`。

新建页默认通过 `agy models` 预加载并聚合为基础模型（`create-model`）与思考等级（`create-reasoning-effort`）两个独立下拉列表（单档位模型自动禁用思考等级选择），同时保留“使用 Antigravity 默认模型”选项；当 `agy models` 暂不可用时允许以默认模型创建，不能被必选下拉框阻断。会话列表中合并展示 SeaBridge 托管会话与 `Antigravity` 桌面端只读会话（外部只读会话明确标识来源且 `sendEnabled: false`）。GET 历史不取得执行所有权。

### 11.2 Telegram（与 Codex / dsh 全能力对齐）

参照现有 `TelegramService`（`src/telegram/service.ts`）中 Codex（`/status`、`/projects`、`/model`、`/new`）与 dsh（`/dsh_status`、`/dsh_projects`、`/dsh_model`、`/dsh_new`）的实现，Antigravity 在 P3 阶段与现有 Telegram 能力逐项对齐如下：

| Telegram 功能项 | Codex / dsh 现有能力 | Antigravity 对齐设计（P3） | 对齐结论 |
| --- | --- | --- | --- |
| **1. 状态查询命令** | `/status`（Codex）、`/dsh_status`（dsh） | 新增 **`/agy_status`**：展示 Antigravity ACP 连接/认证状态、`agy` 版本、活动托管会话数及 `Antigravity` 桌面端只读观察器状态；异常时明确提示且不影响 Codex/dsh。 | **完全对齐** |
| **2. 项目列表命令** | `/projects`（Codex）、`/dsh_projects`（dsh） | 新增 **`/agy_projects`**：列出允许的本地项目序号、名称与路径，并提示快捷创建命令 `/agy_new <序号> <需求>`。 | **完全对齐** |
| **3. 模型与思考等级选择命令** | `/model`（Codex）、`/dsh_model`（dsh） | 新增 **`/agy_model`**：弹出 Inline 菜单选择 Telegram 新建会话的默认**基础模型**（含“跟随 Antigravity 默认”），并在同屏提供当前模型支持的**思考等级（`low` / `medium` / `high`）**切换按钮（单档位模型如 `GPT-OSS 120B (Medium)` 展示等级固定不可调）；偏好按 `chatId` 持久化。 | **完全对齐（并支持思考等级分离选择）** |
| **4. 新建会话（菜单 / 快捷命令 / `ForceReply`）** | `/new`、`/dsh_new`（均支持无参弹出项目分页菜单、`<项目>` 触发 `ForceReply`、`<项目> <需求>` 直接创建） | 新增 **`/agy_new [项目序号/名称] [首轮需求]`**：<br>① 无参弹出项目分页 Inline 菜单（`agy:<token>` 一次性 TTL 回调），点选后发送 `ForceReply`；<br>② 仅带项目参数时直接发送 `ForceReply` 等待输入首轮需求；<br>③ 带项目与需求时直接创建托管会话并发送首轮 prompt，按 `telegram_update_id` 幂等落库，返回含项目、会话 ID、模型与思考等级的回执及 `💬 回复` 按钮。 | **完全对齐** |
| **5. `ForceReply` 待输入冲突与过期保护** | `codex` 与 `dsh` 校验 `(chatId, promptMessageId)` 的 `pending / expired / consumed` 并拦截双端冲突 | 扩展为 `codex / dsh / antigravity` 三方待输入状态校验；过期或已消费提示重新发送 `/agy_new`，多来源冲突直接拒绝执行。 | **完全对齐** |
| **6. 续聊路由（引用回复 / `💬 回复` 按钮 / 无引用最新通知）** | 引用通知、点击 `💬 回复` 触发 `ForceReply`、或直接发送无引用文字（`findLatestReplyMessageId` 查最新通知映射） | ① 引用 Antigravity 消息或点击 `💬 回复` 按钮后回复，精确投递到对应托管会话；<br>② 将 `antigravity_message_links` 纳入 `findLatestReplyMessageId` 联合查询（`desktop_message_links UNION ALL dsh_message_links UNION ALL antigravity_message_links`），无引用文字自动路由至当前 chat 最新可回复通知所属的来源会话；<br>③ 任两来源映射冲突返回 `provider_conflict` 拒绝投递。 | **完全对齐** |
| **7. 轮次终态通知（托管会话 + 桌面端会话观察）** | Codex `DesktopObserver` 与 `DshSessionObserver` 自动观察轮次结束并经 outbox 推送摘要 | ① **托管会话**：每轮终态（`completed / incomplete / cancelled / failed`）经 `antigravity_outbox` 去重推送脱敏摘要与 `💬 回复` 按钮（429 指数退避，超时/断连进入 quarantine 不自动重发）；<br>② **`Antigravity` 桌面端会话观察**：复用 `desktop-reader` 只读观察 `conversation_summaries.db` 与 `transcript.jsonl`，启动时对存量会话建立 baseline 锚点（不补发旧通知），对新完成的桌面端轮次自动推送 Telegram 通知。 | **完全对齐** |
| **8. 桌面端只读通知保护** | `dsh` 只读模式下通知不挂回复按钮，引用回复返回 `dsh_read_only` 提示 | 在 P4 开启 `SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED` 前，`Antigravity` 桌面端外部会话的 Telegram 通知不挂载 `💬 回复` 按钮；若用户直接引用回复该通知，返回明确只读提示（`antigravity_desktop_read_only`），待 P4 验证通过后直接解锁回复。 | **完全对齐** |
| **9. 工具权限审批（Inline Keyboard）** | Codex 通过 `ap:<token>:a/d` 按钮在 Telegram 审批 | 支持 Telegram Inline 按钮审批，且**与 Web 端共享同一条 `antigravity_approvals` pending 记录**；先决者生效并自动清除 Telegram 按钮（`editMessageReplyMarkup`），超时或取消同样结清按钮。 | **完全对齐（且支持 Web + TG 双端同步）** |
| **10. 运行中再次发消息** | Codex 进入原生队列；`dsh` 返回 `busy_or_writer_held` 拒绝排队 | 与 `dsh` 一致：单会话在途执行未完成时，Telegram 再次发送返回 `session_busy` 提示（不排队、不自动重试）。 | **与 `dsh` 一致（首版不排队）** |

### 11.3 ToolHub：独立后续阶段

不直接用本地 executionId 冒充原生 turnId 后塞进 `TaskCodexRunner`。先把 TaskRunner 接口从 Codex 文件中提取到独立合同，再评估新 runner，但这不属于首版修改。

启用 AGY 任务执行之前，至少需证明：工作区权限与 Git/网络限制；原会话身份；精确终态；外部写入可检测或可排除；交付前的历史/工作区版本守卫；release 后不会留下能继续修改候选的 worker。任一不成立则不注册该 runner。

模型返回 end_turn 仅代表交互结束；测试通过、代码冻结、人工验收、提交和合并仍由独立监督器判定。会话能聊天，不等于已经具备受监督交付能力。

## 12. 配置、运维与回滚

以下均为拟新增配置，不是当前已支持的环境变量：

| 配置 | 建议默认值/含义 |
| --- | --- |
| `SEA_BRIDGE_ANTIGRAVITY_ENABLED` | `false`，来源总开关 |
| `SEA_BRIDGE_ANTIGRAVITY_WRITE_ENABLED` | `false`，经验证后开放新建与发送 |
| `SEA_BRIDGE_ANTIGRAVITY_CLI_PATH` | 安装时解析为经校验的绝对路径（如 `/Users/zhuhaijun/.local/bin/agy`），不依赖 LaunchAgent PATH，也不静默混用 `~/.gemini/bin/agy` |
| `SEA_BRIDGE_ANTIGRAVITY_GEMINI_DIR` | 默认 `/Users/zhuhaijun/.gemini`，显式传给 `--gemini-dir` |
| `SEA_BRIDGE_ANTIGRAVITY_APP_DATA_DIR` | 默认 `antigravity-cli`（或专用隔离目录），显式传给 `--app-data-dir`；P0–P3 托管写入不直接指向桌面端 `antigravity` 目录 |
| `SEA_BRIDGE_ANTIGRAVITY_DESKTOP_READ_ENABLED` | `true`（当总开关开启时），只读读取 `~/.gemini/antigravity` 下的 `conversation_summaries.db` 与 `transcript.jsonl` 展示 `Antigravity` 桌面端会话 |
| `SEA_BRIDGE_ANTIGRAVITY_MAX_ACTIVE` | `1`，首版并发预算 |
| `SEA_BRIDGE_ANTIGRAVITY_APPROVAL_TIMEOUT_MS` | `300000`，超时取消执行，不自动批准 |
| `SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED` | `false`，仅在 P4 验证桌面端原会话写入互通与跨进程 SQLite WAL 并发安全后开放 |

允许项目和经验证的权限配置由本地服务端文件维护，不接受网页提交原始 CLI flags。版本探测在启用/运维时进行，不在每次页面刷新时执行；不设置自动升级任务。

关闭写入开关先停止接纳，不静默取消正在运行的任务；运维界面明确展示需要等待或显式取消的执行。服务关闭须结清权限请求、持久化未确认状态并清理自己拥有的 worker。

发布前保存应用构建、数据库一致性备份及配置版本；停写后迁移并进行小范围试用。回退优先关闭 AGY 来源、保留兼容 schema 和审计，而不是删除所有 Antigravity 数据。

若必须退回不认识新 schema 的旧二进制，需要先验证其读路径兼容性；不兼容时采用专门回退迁移或受控恢复。不得直接恢复旧整库覆盖上线后新产生的 Codex/dsh 操作。AGY 二进制升级备份不能代替 SeaBridge 数据库备份。

## 13. 实施阶段与交付门槛

### P0：协议、隔离与真实行为验证

产物：脱敏 fixture、能力矩阵、安全边界记录、资源测量与 Go/No-Go 结论。

- [x] 固定 AGY 1.5.2/ACP v1 和当前二进制摘要；复用已有初始化证据及 `agy models` 只读输出证据。
- [x] 验证本机帮助中 `--app-data-dir`、`--gemini-dir` 等目录参数的实际解析范围；确认传入专用隔离目录（或 `antigravity-cli`）时完全不向 `Antigravity.app` 的 `~/.gemini/antigravity` 写入。
- [x] 在不复用真实会话目录的前提下解决目标 `app-data-dir` 下的认证；凭据不放进测试仓库，不复制整个真实 HOME。
- [x] 验证权限规则、沙箱、插件/技能/MCP 是否符合明确配置；不安全则停止写入接入。
- [x] 获得实施/实机测试授权后，只用明确标注的隔离会话验证 new、两轮 prompt、load/resume、close、模型与思考等级选项（确认 `agy models` 聚合出的 `(modelId, reasoningEffort)` 与 `session/new` 返回的 `configOptions` 映射关系，并可通过 `session/set_config_option` 切换）、允许/拒绝及 cancel。
- [x] 记录是否会在 `Antigravity.app`（桌面 2.0）出现测试会话，确保隔离托管会话不污染用户桌面列表；临时 cwd 本身不等于会话存储隔离。

**门槛：** 只允许声明实际验证通过的能力。真实存储隔离或权限边界无法证明时，继续模拟测试，不在真实用户环境创建合成任务。

### P1：ACP 基础层、模型/思考等级目录、桌面只读读取器与迁移

产物：transport、client、model-catalog、desktop-reader、持久会话/执行、能力门控、假 Agent 测试、迁移测试。

- [x] 实现 NDJSON 分帧、双向 request/response、通知、错误及大小/并发限制。
- [x] 支持 stdin 背压、分片 UTF-8、超长帧、格式错误、乱序响应、重复 ID 与异常退出。
- [x] 实现 `model-catalog`（解析 `agy models` 输出、剥离进度转轮控制符、按家族聚合基础模型 `id/name` 与思考等级 `defaultReasoningEffort/supportedReasoningEfforts`、维护双向变体映射并缓存）与 `desktop-reader`（以 `mode=ro` 只读查询 `~/.gemini/antigravity/conversation_summaries.db` 顶层会话及解析 `brain/<id>/.system_generated/logs/transcript.jsonl`）。
- [x] 实现异步执行状态、幂等、单会话串行化、取消屏障和重启不重放。
- [x] 增加 AGY 自有表及显式 web source CHECK 迁移。
- [x] 默认开关关闭，Codex/dsh 路径与类型回归通过。

**门槛：** 不连接真实模型也能用故障注入和脱敏 fixture 证明状态、模型与思考等级分离聚合、桌面只读读取与数据库迁移正确。

### P2：Web 托管会话 + 新建前选模型/思考等级 + 桌面会话只读展示 MVP

产物：Antigravity 来源、新建前“模型 + 思考等级”分离下拉选择、托管会话新建/续聊/历史/配置/审批/停止、`Antigravity` 桌面端会话列表与历史只读展示闭环。

- [x] 扩展来源注册、输入校验、存储与页面渲染。
- [x] 完成本地项目目录与基于 `agy models` 的新建前“模型 + 思考等级”分离下拉选择（多档位模型联动 `create-reasoning-effort`，单档位模型自动禁用等级下拉框，含默认模型兜底）；绝不创建模型探测空会话。
- [x] 接入 `desktop-reader`，在 Web 会话列表中合并展示 `Antigravity` 桌面端顶层会话及其运行状态与只读历史（标记 `sendEnabled: false`）。
- [x] 完成 Web 审批、停止、回放隔离、历史完整性提示。
- [x] 打通故障后的状态呈现；不隐式新建、不自动重发。
- [x] 在 P0 已验证的隔离环境进行最小真实验收。

**门槛：** 首版定义的 Web 功能（含新建前选模型与 `Antigravity` 桌面端只读会话展示）均有实机证据；协议声明但未验证的按钮不开放。到这里即可交付“SeaBridge 托管 Antigravity 会话 + 桌面端会话只读查看”，对桌面端外部会话的写入续聊保持关闭。

### P3：Telegram 全能力接入（命令菜单、新建、续聊、通知观察器与双端共享审批）

产物：`/agy_status`、`/agy_projects`、`/agy_model`（模型 + 思考等级菜单）、`/agy_new`（分页菜单 / 快捷创建 / `ForceReply`）、精确消息路由、托管与桌面端会话通知 outbox、跨 Web/Telegram 的统一审批。

- [x] 在 `TelegramService` 中注册并实现 `/agy_status`、`/agy_projects`、`/agy_model`（支持基础模型与 `Effort` 思考等级独立选择，单档位模型自动禁用等级切换）、`/agy_new`（无参项目菜单、`<项目>` 触发 `ForceReply`、`<项目> <需求>` 一步创建及 `telegram_update_id` 幂等保护）。
- [x] 扩展 `routeProviderReply` 与 `findLatestReplyMessageId` 支持 `codex / dsh / antigravity` 三来源路由、三方 `pending prompt` 冲突拦截、映射冲突拒绝（`provider_conflict`）以及桌面端外部会话只读回复提示（`antigravity_desktop_read_only`）。
- [x] 实现托管会话终态通知与 `Antigravity` 桌面端只读会话观察器（启动 baseline 不补发历史通知，新完成轮次经 `antigravity_outbox` 去重推送，429 退避与发送未知 quarantine）。
- [x] 打通 Web 与 Telegram 共享同一条 `antigravity_approvals` pending 记录；审批重复点击、过期、设备/用户失权、取消后点击均有测试。

**门槛：** Telegram 端具备与 Codex / dsh 对齐的命令、选模型/思考等级、新建、续聊、通知和审批体验；三来源同 chat 混用仍不串会话、不串审批。

### P4：`Antigravity` 桌面端与 `agy` CLI 原会话写入互通（`Antigravity IDE` 暂不考虑）

产物：按 `Antigravity.app`（桌面 2.0）与 `agy` CLI 分列的写入互通证据表、跨进程 SQLite WAL 兼容性结论及 `SEA_BRIDGE_ANTIGRAVITY_EXTERNAL_SESSIONS_ENABLED` 开关决策。

- [x] 分别在 `antigravity-cli`（对应 `agy` CLI）与 `antigravity`（对应 `Antigravity.app 2.29.0`）目录下验证同 ID 写入续聊、历史同步、停止与恢复。
- [x] 验证 `agy acp` 与 `Antigravity.app` 的 `language_server` 并发访问同一 `conversations/<id>.db` 及 `conversation_summaries.db` 时的 WAL 锁行为与 schema 兼容性。
- [x] 无法证明同一原会话安全写入互通时，保持桌面端会话在 Web 端仅只读展示（`sendEnabled: false`），不以导入副本冒充通过。
- [x] 只为通过合同的目标版本、目录和会话类型开放外部会话写入操作。

**门槛：** 失败不影响已交付的托管会话与桌面端只读展示，外部会话写入保持关闭。

### P5：ToolHub 受监督执行

产物：独立任务协议设计、runner 能力合同、权限与交付守卫测试。

- [ ] 先确认第 11.3 节的证据要求，再扩展私有任务协议。
- [ ] 继续区分模型终态、测试、人工验收与合并。
- [ ] 两项目分别验证、分别记录部署；不复用首版聊天验收代替任务安全验收。

**门槛：** 不满足任务监督合同则不注册 runner；不能为了界面上出现选项而放宽安全边界。

## 14. 拟修改文件与测试范围

### 14.1 文件清单与模块化守卫（单文件 ≤ 400 行）

当前仓库中 `src/telegram/service.ts`（1,152 行）与 `src/main.ts`（372 行）已超过或接近 400 行模块化红线。本次接入严禁继续向这两个文件堆砌内联业务分支，必须将 Antigravity 装配与 Telegram 命令/回调处理封装在独立模块中（每个新增文件均控制在 400 行以内）：

| 类型 | 路径 | 用途 |
| --- | --- | --- |
| 新增 | `src/antigravity/{transport,client,protocol,capabilities}.ts` | ACP 传输、运行时类型与能力协商 |
| 新增 | `src/antigravity/{model-catalog,desktop-reader}.ts` | `agy models` 家族聚合预加载缓存、`Antigravity` 桌面端只读会话/历史读取 |
| 新增 | `src/antigravity/{session-manager,store,projection}.ts` | 执行所有权、账本、历史投影 |
| 新增 | `src/antigravity/{policy,approval-bridge,config,bootstrap}.ts` | 安全策略、审批、配置及主进程生命周期装配（减轻 `src/main.ts` 体积） |
| 新增 | `src/web/sources/antigravity.ts` | WebSource 适配（合并托管会话与桌面只读会话） |
| 修改 | `src/config.ts`、`src/main.ts`、`src/state/db.ts` | 配置开关、`bootstrap` 委托挂载、`migrateAntigravityBridgeTables` 核心表迁移 |
| 修改 | `src/web/{types,status,runtime,http,operations,store,migrations,session-list,records}.ts` | 三来源扩展、`queued -> accepted` 二阶段状态推进、模型/思考等级切换、停止与 Web 审批接口、列表过滤与诊断记录 |
| 修改 | `src/web/sources/types.ts`、`src/web/public/{app.js,index.html,app.css}` | 执行控制、Web 审批能力、模型/思考等级联动和 UI |
| 后续新增/修改（P3） | `src/antigravity/{telegram-handler,menu-ui,new-session-manager,reply-router,desktop-observer}.ts`、`src/telegram/{provider-reply-router,service}.ts` | P3 独立封装 `/agy_*` 命令与 `agy:` 回调处理器（`service.ts` 仅做薄委托）、三方回复路由、桌面会话通知观察与双端共享审批 |
| 文档更新 | `README.md`、`docs/deployment.md` | 实施后写入真实支持范围与配置 |

命名可按实施时职责拆分，但不把整套协议与 UI 塞进一个大文件。不在首版重构 Codex 核心或改写历史设计文档。

### 14.2 验收矩阵

| 场景 | 必须验证的结果 |
| --- | --- |
| 新建页“模型 + 思考等级”分离加载（`agy models`） | 正确剥离转轮控制符并聚合为 5 个基础模型与各自支持的 `Effort`（多档位模型可切换 `low/medium/high` 且默认档位与 `agy` 一致，单档位模型如 `GPT-OSS 120B (Medium)` 自动禁用思考等级下拉框）；超时/异常时仍可用默认模型创建 |
| 新建一次（选定模型 + 思考等级）、发送两轮、断开后恢复 | 同一 nativeSessionId；通过 `session/set_config_option` 正确应用 `(modelId, reasoningEffort)`，会话元数据分离展示 `model` 与 `reasoningEffort`，且不出现第二个隐式会话 |
| `Antigravity` 桌面端会话只读展示 | 正确过滤子代理（`nesting_depth = 0`），展示标题、运行状态与 `transcript.jsonl` 历史；`sendEnabled: false` 且不触发 `session/load` |
| new 响应丢失 | unknown；没有自动 new，也不猜测最近 ID |
| 同 operationId 重复、并发提交、内容不同 | 相同结果/只派发一次/明确冲突 |
| prompt 已送出后崩溃 | 不重发；执行 unknown；保留证据 |
| 元数据更新、空闲静默、进程退出 0 | 不误判 accepted 或 completed |
| 工具失败后 end_turn | 展示失败；不声称业务成功 |
| 取消与结束竞争、旧页面停止新一轮 | 不取消错误执行；旧 worker 退出前不派发后续 prompt |
| 审批允许/拒绝/超时/双击/取消后点击 | 精确 optionId；至多一次决策；不会过期放行 |
| 回放无稳定 messageId、重复文本、回放中断 | 不重复追加、不删真实重复消息、不伪造完整历史 |
| 外部会话运行、权限变化、目录越界 | 禁止未验证控制；不自动扩大访问范围 |
| 账号/版本变化、可选能力缺失 | 缓存失效，明确能力降级，不隐式切换后端 |
| Telegram `/agy_model` 与 `/agy_new` 全流程 | `/agy_model` 可分别选择基础模型与思考等级（单档位模型不可调等级）；`/agy_new` 支持菜单点选、`ForceReply` 与命令直建，相同 `update_id` 不重复创建 |
| 三来源同 chat 路由、映射冲突与桌面只读通知 | 引用回复、`💬 回复` 按钮及无引用最新通知正确路由到单来源；映射冲突或 `pending prompt` 冲突明确拒绝；回复桌面只读通知返回 `antigravity_desktop_read_only` 提示 |
| 旧库升级、迁移中断、索引/外键 | 数据保留、一致性检查通过、失败可回滚 |
| 关闭功能、服务重启、停写发布 | 不启动新 AGY；已运行工作有明确处理记录 |
| 默认测试运行 | 不连接真实模型，不写默认 AGY 会话目录 |
| Codex/dsh 回归 | 现有创建、续聊、审批、停止和任务接口不变 |

### 14.3 验证命令与执行范围

以下是实施阶段应执行的命令，**不是本次文档编写已经执行的产品测试**。新测试文件名是计划名称：

```bash
# 先静态检查，再运行测试；本项目当前没有独立 lint/format script。
bun run typecheck
node --check src/web/public/app.js
git diff --check

# 拟新增的针对性测试。
bun test tests/antigravity-transport.test.ts \
  tests/antigravity-model-catalog.test.ts \
  tests/antigravity-desktop-reader.test.ts \
  tests/antigravity-session-manager.test.ts \
  tests/antigravity-approval.test.ts \
  tests/antigravity-history.test.ts \
  tests/antigravity-migrations.test.ts \
  tests/web-antigravity-source.test.ts

# 已存在的关键回归，以及最终全量验证。
bun test tests/codex-app-server-client.test.ts \
  tests/web-codex-source.test.ts tests/web-dsh-source.test.ts \
  tests/web-operations.test.ts tests/web-store.test.ts tests/web-http.test.ts \
  tests/web-status.test.ts tests/telegram-thread-reply-router.test.ts \
  tests/task-codex-runner.test.ts tests/task-conversations.test.ts
bun test
bun run build
```

真实模型 smoke 独立于默认测试，必须显式启用并确认隔离数据目录；失败应报告证据，不退回真实 HOME 再试。实机验证记录版本、输入范围、会话身份、结果和清理情况，不记录令牌。

## 15. 风险、降级和完成定义

| 风险 | 应对方式 |
| --- | --- |
| 桌面端 `conversations/<id>.db` 跨进程并发写存在锁风险 | P2 采用 `conversation_summaries.db`（`mode=ro`）+ `transcript.jsonl` 只读展示桌面端会话；跨进程写入留待 P4 验证 |
| `agy models` 输出含转轮控制符或临时超时 | 解析器剥离控制序列并带 `CatalogCache`；探测失败时降级为“使用默认模型”创建，不阻塞新建会话 |
| 会话取消无法证明不会误伤下一轮 | 首版取消后回收 worker；仍不通过则禁用该控制能力 |
| 没有原生持久幂等键或可验证轮次 ID | 使用本地账本避免重复派发；跨崩溃的不确定结果不自动重试 |
| 默认允许规则绕过桥接审批 | P0 检查实际策略；边界不清则不开写入，不修改用户全局规则 |
| load 具有恢复行为 | 历史 GET 读本地投影或桌面端只读 `transcript.jsonl`；恢复动作串行且显式 |
| AGY 版本或协议扩展变化 | 固定验收版本/fixture，能力门控，无自动升级 |
| 数据库迁移影响 Codex/dsh | 旧库 fixture、外键/索引核对、故障注入与受控回退 |
| 新功能只验证 API，忽略用户界面 | 桌面会话只读可见性、新建前“模型 + 思考等级”双下拉联动、正常回复格式、没有重复会话都列入验收 |

Web MVP 完成必须同时满足：新建前可分别选择模型与思考等级（基于 `agy models` 家族聚合）；真实隔离环境中的新建与同会话续聊通过；`Antigravity` 桌面端顶层会话列表与历史只读展示正常；消息/工具/终态区分正确；审批与停止有证据；失败不重复执行；数据库迁移与 Codex/dsh 回归通过；关闭开关可停止接纳；部署与回退经过记录。

桌面原会话写入互通（P4）、Telegram（P3）和 ToolHub（P5）分别有独立完成状态，不用一个“Antigravity 已接入”掩盖未验证的能力。

## 16. 本次文档交付与后续决策

本次只新增并修订这份方案，重新核对了源码、`agy` 版本/专用帮助、`agy models` 只读输出、`Antigravity.app`（`2.29.0`）的真实后台进程与 `~/.gemini/antigravity` 下 `conversation_summaries.db` 及 `transcript.jsonl` 结构，以及保存的初始化验收记录。没有创建 Agent 会话、发送模型提示词、修改产品代码、增加依赖、升级 App/IDE 或部署服务。

下一阶段应从 P0 开始，并按**分阶段独立子计划（Sub-plan）**推进实施，避免将 P0–P5 塞进单次巨型编码计划：
1. **子计划 1（P0 + P1 + P2，首轮实施目标）**：完成 P0 协议/隔离实测后，交付 ACP 基础层、`model-catalog`（模型 + 思考等级分离聚合）、`desktop-reader`（`Antigravity` 桌面端只读列表与历史）以及 Web 托管会话闭环。
2. **子计划 2（P3）**：在 Web MVP 稳定后，独立交付 Telegram 全能力接入（`/agy_*` 命令菜单、三方回复路由、桌面会话观察通知与双端共享审批）。
3. **子计划 3（P4）**：独立验证 `Antigravity` 桌面端与 `agy` CLI 的跨进程 SQLite WAL 写入互通。
4. **子计划 4（P5）**：独立评估 ToolHub 受监督任务执行合同。

需要实测才能决定的问题已经转化为明确门槛：隔离目录与认证方式、权限边界、原生会话身份、取消竞态、`agy models` 聚合出的 `(modelId, reasoningEffort)` 与会话 `configOptions` 的映射关系、以及 P4 桌面端原会话跨进程写入互通；在结果出来前不把未验证的写入能力写成已支持。

文档自审重点：保持“声明支持/实测通过/拟实现”区分；不把导入当原会话；不把本地锁当原生所有权；不把 accepted/end_turn 当业务交付；不遗漏来源 CHECK 迁移；不通过回滚覆盖其他来源的新数据。

## 参考资料

公开资料核对日期为 2026-11-07。线上协议文档可能继续演进；实现以本机 1.5.2 的脱敏 fixture 和对应 ACP v1 合同为边界。

- [R1：Google Antigravity CLI — ACP][R1]：官方 stdio 接入入口。
- [R2：Google Antigravity — Other editors / ACP][R2]：会话选项、权限、认证与启动参数。
- [R3：ACP v1 — Initialization][R3]：初始化与能力协商。
- [R4：ACP v1 — Session Setup][R4]：new/load/resume/close 的不同语义。
- [R5：ACP v1 — Session List][R5]：目录发现与分页。
- [R6：ACP v1 — Session Config Options][R6]：模型等配置的动态选项与设置方法。
- [R7：ACP v1 — Prompt Turn][R7]：流式更新、最终响应与停止原因。
- [R8：ACP v1 — Tool Calls][R8]：权限请求及响应。
- [R9：Google Antigravity CLI — Resume][R9]：桌面会话导入复制与按 ID 恢复。
- [R10：Google Antigravity CLI — Headless][R10]：stream-json 路线及其限制。
- [R11：ACP v1 — Cancellation][R11]：取消与 pending 权限请求结算。

[R1]: https://antigravity.google/docs/cli/acp/
[R2]: https://antigravity.google/docs/ide/extensions/acp/
[R3]: https://agentclientprotocol.com/protocol/v1/initialization
[R4]: https://agentclientprotocol.com/protocol/v1/session-setup
[R5]: https://agentclientprotocol.com/protocol/v1/session-list
[R6]: https://agentclientprotocol.com/protocol/v1/session-config-options
[R7]: https://agentclientprotocol.com/protocol/v1/prompt-turn
[R8]: https://agentclientprotocol.com/protocol/v1/tool-calls
[R9]: https://antigravity.google/docs/cli/commands/resume/
[R10]: https://antigravity.google/docs/cli/headless/
[R11]: https://agentclientprotocol.com/protocol/v1/cancellation
