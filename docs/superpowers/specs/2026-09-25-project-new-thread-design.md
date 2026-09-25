# Design Spec: 项目下新建会话与模型切换 (Project New Thread & Model Switch)

- **Date**: 2026-09-25
- **Project**: sea-bridge
- **Branch**: feature/project-new-thread
- **Status**: Approved

---

## 1. 目标与背景

当前 Sea-Bridge 仅具备基于既有会话的通知与回复功能（通过 `codex queue --thread <threadId> --message <text>` 进行消息追加入队）。用户在移动端使用 Telegram 时，如果想要针对某个本地项目发起全新的任务，必须回到桌面端手动新建会话，打断了移动端自主闭环的工作流。

本功能的目标是：
1. **支持在指定项目下新建 Codex Desktop 会话**：通过 Telegram 既可一步直达，亦可交互点选。
2. **支持自主切换会话模型**：提供 Telegram 菜单选择与切换用户偏好的默认模型。
3. **环境选择保持 Codex 内部规范**：根据既定原则，运行环境隔离（如 worktree 等）继续由 Codex 内部规范流程负责，不在外部强行分步阻塞。
4. **与既有回复机制无缝闭环**：新会话创建并投递首轮需求后，自动绑定入库，用户在 Telegram 后续发出的消息自动路由给该新建会话。

---

## 2. 总体架构设计

采用基于 Codex Desktop 官方底层 **`codex app-server --stdio`** 协议的轻量化交互方案：

```
┌─────────────────────────────────────────────────────────────────┐
│                         Telegram Client                         │
│       Commands: /projects, /model, /new [project] [prompt]      │
│       Callbacks: proj:<projectId>, model:<modelId>              │
└───────────────────────────────┬─────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│                       TelegramService                           │
│       - 注册命令与回调拦截                                      │
│       - 维护并持久化用户默认模型设置                            │
└───────────────┬───────────────────────────────┬─────────────────┘
                │                               │
                ▼                               ▼
┌───────────────────────────────┐ ┌───────────────────────────────┐
│       CodexProjectStore       │ │     CodexAppServerClient      │
│   - 直读 state_5.sqlite       │ │   - 短连接 JSON-RPC 通信      │
│   - 解析 projects 与 roots    │ │   - model/list 获取可用模型   │
│   - 构建 1-based 序号与名称   │ │   - thread/start 创建会话     │
└───────────────────────────────┘ └──────────────┬────────────────┘
                                                 │
                                                 ▼
                                  ┌───────────────────────────────┐
                                  │    ProcessCodexQueueClient    │
                                  │   - 投递新会话的首轮需求      │
                                  └──────────────┬────────────────┘
                                                 │
                                                 ▼
                                  ┌───────────────────────────────┐
                                  │      DesktopMessageStore      │
                                  │   - 关联回执消息与新 threadId │
                                  │   - 激活直接回复上下文        │
                                  └───────────────────────────────┘
```

---

## 3. 核心模块与接口规范

### 3.1 项目管理存储 (`CodexProjectStore`)
- **文件路径**: `src/desktop/codex-project-store.ts`
- **数据源**: 复用当前环境的 `state_5.sqlite`（通过 `config.codexStateDbPath` 配置）。
- **数据结构**:
  ```ts
  export interface ProjectItem {
    index: number;         // 1-based 显示序号
    id: string;            // UUID
    name: string;          // 显示名称
    rootPath: string;      // 物理路径
    position: number;      // 排序权重
  }
  ```
- **主要方法**:
  - `listProjects(): ProjectItem[]`: 读取数据库 `projects` 及 `project_roots` 表，滤除路径不存在的项目，按 `position ASC` 排序并赋予序号。
  - `findProject(query: string): ProjectItem | null`: 尝试按数字序号（如 `"1"`）、完整项目名或忽略大小写名称匹配。

### 3.2 引擎协议客户端 (`CodexAppServerClient`)
- **文件路径**: `src/desktop/codex-app-server-client.ts`
- **通信方式**: `child_process.spawn(codexCliPath, ["app-server", "--stdio"])`。
- **协议握手**:
  - 启动后首个包发送 `initialize`：
    ```json
    {
      "method": "initialize",
      "id": 1,
      "params": {
        "clientInfo": { "name": "sea-bridge", "version": "1.0.0" },
        "capabilities": { "experimentalApi": true }
      }
    }
    ```
- **核心能力**:
  1. `listModels(): Promise<Array<{ id: string; displayName: string; isDefault: boolean }>>`:
     - 握手成功后发送 `{ "method": "model/list", "id": 2, "params": {} }`；
     - 解析返回的可选模型列表；
     - 具备 5 秒超时与失败降级机制（降级使用内置常用模型列表：`gpt-5-codex`, `o3`, `gpt-5`）。
  2. `startThread(params: { projectId: string; cwd: string; model?: string }): Promise<{ threadId: string }>`:
     - 发送 `{ "method": "thread/start", "id": 2, "params": { "projectId": params.projectId, "cwd": params.cwd, "model": params.model } }`；
     - 收到返回后提取 `result.thread.id`；
     - 成功或失败均主动释放子进程。

### 3.3 用户模型偏好配置持久化
- **存储位置**: `StateDb`（`~/.sea-bridge/state.sqlite` 或内部配置表）。
- **配置项**:
  - 键名: `default_model`
  - 默认值: 未指定时为空（遵循 Codex 桌面引擎内部默认模型）。

---

## 4. Telegram 交互流转定义

### 4.1 `/model` 菜单切换流
1. 用户输入 `/model`；
2. 服务端通过 `CodexAppServerClient.listModels()` 获取模型列表；
3. 读取当前用户的默认模型偏好；
4. 渲染 Inline Keyboard 菜单（已选中的模型带有 `🔘` 标志，其他为普通按键）；
5. 用户点击按钮，触发回调 `model:<modelId>`：
   - 更新数据库中的默认模型偏好；
   - 响应回调并在 Telegram 更新按钮状态。

### 4.2 `/projects` 清单查询流
1. 用户输入 `/projects`；
2. 服务端调用 `CodexProjectStore.listProjects()`；
3. 格式化输出序号、项目名与绝对路径，附带新建提示：
   ```text
   📁 Codex 纳管项目列表：
   [1] sea-bridge (/opt/app/aitools/sea-bridge)
   [2] aining (/opt/app/aining)
   [3] xc-web (/opt/app/aining/xc-web)
   ...
   💡 快捷创建：发送 /new <序号或项目名> <你的需求>
   ```

### 4.3 `/new` 创建会话流
1. **参数解析**:
   - 若指令形式为 `/new <项目标识> <需求文本>`（例如 `/new 1 审查一下当前分支代码`）：
     * 匹配到项目则直接进入【创建与投递阶段】；
   - 若仅输入 `/new` 或未提供项目标识：
     * 弹出前 8 个常用项目的 Inline Keyboard 供点击选择；
     * 用户点击项目按钮后，若原指令无需求文本，则发送引导提示：“💬 请回复此消息，输入在该项目下的第一轮需求”。
2. **创建与投递阶段**:
   - 提取目标项目的 `id` 与 `rootPath`；
   - 获取当前配置的偏好模型；
   - 调用 `CodexAppServerClient.startThread()` 创建会话并获取 `threadId`；
   - 调用 `ProcessCodexQueueClient.queue(threadId, "[Telegram init]\n" + prompt)` 将初始需求入队；
   - 发送 Telegram 成功通知：
     ```text
     🚀 已在项目 [sea-bridge] 下创建新会话！
     会话 ID: 01a0d707-...
     选用模型: gpt-5-codex
     已投递首轮需求: 审查一下当前分支代码
     ```
   - 将发送出的回执消息写入 `DesktopMessageStore` 进行链接映射；后续用户直接回复即可无缝交互。

---

## 5. 异常处理与边界防护

1. **项目路径失效**: 若项目在数据库存在但在物理磁盘不存在，`CodexProjectStore` 在查找阶段直接阻断并提示路径不可达。
2. **app-server 通信超时**: 无论 `model/list` 还是 `thread/start`，均设立 5000ms 定时器。若子进程无响应或阻塞，强制执行 `SIGKILL` 并返回明确错误码，避免 Sea-Bridge 队列被 hang 住。
3. **部分失败防护（会话已建但首轮投递失败）**: 若 `thread/start` 成功获得 `threadId`，但在后续 `queueClient.queue` 异常退出，系统依然登记会话映射，并向用户提示：“会话已创建，但首轮消息未能自动入队，请直接回复本消息重试发送。”
4. **并发防重**: 基于 Telegram `update_id` 保证幂等执行，并在进行 `thread/start` 时增加会话级别简单互斥锁，防止用户快速连击导致启动多个重复会话。

---

## 6. 测试与验收标准

1. **单元测试**:
   - `tests/codex-project-store.test.ts`: 测试 SQLite 读取项目数据、序号映射、按名称/序号查验及不存在路径拦截。
   - `tests/codex-app-server-client.test.ts`: 模拟 stdio 上的 JSON-RPC 往返，测试初始化握手、`model/list` 结构解析、`thread/start` 成功与超时 kill。
   - `tests/telegram-new-thread.test.ts`: 测试 `/projects` 展示、`/model` 选择更新、`/new` 一步直达与分步回调。
2. **验收命令**:
   - `bun test` 全部通过；
   - 在本地 Telegram 发送 `/projects` 能正确返回已纳管项目；
   - 发送 `/new sea-bridge 测试创建会话` 能在 Codex Desktop 侧边栏的 sea-bridge 项目下生成新会话并自动开始执行第一轮任务。

