# Sea-Bridge 借鉴 Codex 原生布局体验升级设计文档

- **创建日期**: 2026-10-12
- **状态**: 待评审 (Ready for Review)
- **目标组件**: Sea-Bridge 会话详情页、输入控制器、后端 Codex App Server 桥接

---

## 1. 背景与目标

Sea-Bridge 作为一个部署在本地 Mac 上、方便通过手机浏览器远程跟进和继续会话的控制台，核心体验诉求是**低交互阻尼、高状态确定性与长会话空间感知**。

在参考桌面端 Codex 原生界面的布局规范后，针对当前 Sea-Bridge 存在的长任务等待盲区、多选项纯手动输入繁琐、长滚动空间迷失以及输入框功能单一等问题，本次升级将同步落地四个模块：
1. **实时活动流 (Live Activity Feed)**：在任务执行中直观呈现耗时与最近微观操作，消除等待焦虑。
2. **快捷决策胶囊 (Quick Action Pills)**：从助手回复中提取“一镜到底”等选项，支持移动端单键轻点直发。
3. **输入框控制台化 (Composer Hub)**：集成模型与思考强度指示，并在任务运行态将主按钮翻转为真实的“停止/中断”控制器。
4. **垂直轮次指示轨 (Turn Timeline Rail)**：双端响应式呈现长会话轮次进度与快速定位能力。

---

## 2. 总体架构与数据流

整体系统架构保持 Sea-Bridge 的 REST + SSE 混合管道设计，在不破坏现有权限、脱敏与会话一致性契约的前提下，扩展实时感知与控制能力：

```
[ 手机/Web 前端 (app.js / app.css) ]
       │                                  ▲
       │ 1. POST /interrupt (中断)        │ 2. SSE 状态与活动推送
       ▼                                  │
[ Web 服务端 (http.ts / sources/codex.ts) ]
       │
       ▼ 3. RPC: turn/interrupt
[ Codex App Server (codex-app-server-client.ts) ]
       │
       ▼
[ Codex 本地会话引擎 / 工作区 ]
```

---

## 3. 详细模块设计

### 3.1 后端中断 RPC 与端点扩展 (Backend Interrupt)

#### 3.1.1 App Server RPC 扩展
在 `src/desktop/codex-app-server-client.ts` 中，基于官方 `turn/interrupt` 协议契约实现中断调用：
- **请求格式**：`method: "turn/interrupt"`，参数包含 `threadId: string` 与 `turnId: string`。
- **调用逻辑**：
  ```typescript
  async interruptTurn(params: { threadId: string; turnId: string }): Promise<void> {
    await this.request("turn/interrupt", {
      threadId: params.threadId,
      turnId: params.turnId,
    });
  }
  ```

#### 3.1.2 适配器与 HTTP 端点
- **适配器接入**：更新 `src/desktop/same-session-adapter.ts`，将原本返回 `UNAVAILABLE_DESKTOP_INTERRUPT` 的桩方法替换为真实的 RPC 派发逻辑。
- **新增端点**：`POST /api/sessions/codex/:id/interrupt`
  - **前置条件**：校验用户登录凭证、会话 ID 存在，且会话处于 `running` 状态。
  - **逻辑**：获取当前运行中的 `activeTurnId`，调用 `interruptTurn`。
  - **返回值**：成功返回 `{ ok: true, status: "interrupting" }`；若当前会话未在运行或无活动轮次，幂等返回 `{ ok: true, status: "idle" }`。

---

### 3.2 运行态实时活动流 (Live Activity Feed)

#### 3.2.1 前端呈现结构
在会话处于 `running` 状态时，在消息流尾部动态挂载 `.live-activity-card`：
- **计时与阶段**：
  - 顶部展示带呼吸微光的动画图标与实时跳动的耗时：`已处理 MM分 SS秒`。
  - 阶段说明展示当前主阶段（如 `已切换至极速一镜到底模式，正在落盘设计与实施文档`）。
- **当前微活动 (Granularity A: 单条最新)**：
  - 展示当前正在执行的操作，例如 `📖 正在读取 2026-10-12-xc-web-course-portal-chapter-overflow-review.md`。
- **完成态收拢**：
  - 收到助手最终回复时，活动卡片平滑淡出，不污染聊天历史持久化内容。

---

### 3.3 选项快捷操作胶囊 (Quick Action Pills)

#### 3.3.1 识别规则
在前端 `renderMarkdown` 渲染助手回复时，增加语义提取器：
1. **显式语法**：解析 `- :codex-followup[<文案>]{prompt="<指令>"}`。
2. **启发式规则**：
   - 提取包含“推荐输入 X”、“输入 X 进入...”、“选项 1: ...”等引导语。
   - 提取诸如“一镜到底”、“确认继续”、“新建 Worktree”等关键行动短语。

#### 3.3.2 交互与单键直发
- **视觉**：在助手气泡卡片底部右下角渲染一排高对比度的胶囊按钮 `.action-pills`。
- **直发行为**：
  - 用户轻点胶囊，按钮即刻置灰显示 `正在提交…`；
  - 自动调用现有的 `submitWrite()` 方法将提取出的 prompt 发送到后台；
  - 若遇网络异常，恢复按钮可用态，并将 prompt 自动回填至输入框供手动重试。

---

### 3.4 输入框控制台化 (Composer Control Hub)

#### 3.4.1 布局分区
升级现有的 `.composer` 结构：
- **上层**：自适应弹性文本输入框（1~3 行高度随打字平滑扩展）。
- **下层工具栏**：
  - **左侧**：显示当前权限徽标（`🛡️ 完全访问` / `受限`）。
  - **右侧**：
    - 模型指示徽标：展示当前模型（如 `agy/gemini-3.8-flash-medium`）与推理档位（`中`）。
    - 运行指示：在执行态时带有微型旋转 Spinner 动效。
  - **主操作按钮状态机**：
    - **空闲态 (Idle)**：展示 `↑ 发送` 按钮（输入框有文字时激活高亮）。
    - **运行态 (Running)**：动态翻转为**红色矩形 `⏹ 中断` 按钮**。
      - 用户点击中断后，按钮变为 `正在中断…` 并发起 `POST /interrupt` 请求。

---

### 3.5 垂直轮次指示轨 (Turn Timeline Rail)

#### 3.5.1 响应式设计
- **桌面端 (视口 > 760px)**：
  - 在消息区域左侧渲染垂直进度轨 `.turn-rail`，每个 User Turn 对应一个刻度线 `.turn-tick`。
  - 视口监听：利用 `IntersectionObserver` 实时高亮当前正在阅读的轮次。
  - 交互：悬停展示该轮提问摘要；点击平滑滚动跳转至目标消息。
- **移动端 (视口 ≤ 760px)**：
  - 不侵占屏幕宽度，滑动时在右下角悬浮显示微型轮次胶囊：`第 X / Y 轮 · 耗时`。
  - 滑动停止 2 秒后自动渐隐；轻点可呼出简易轮次跳转抽屉。

---

## 4. 边界处理与健壮性

1. **中断并发竞态**：若用户点击中断时，模型恰好已生成完毕或进程已自然退出，服务端优雅处理为成功，前端平滑切回空闲态，不弹错误红框。
2. **移动端键盘适配**：保持 Sea-Bridge 的 `keyboard-open` 视口自适应机制，软键盘唤起时自动收起轮次轨与全局头，保持控制台与输入框紧凑贴合。
3. **断网与重连**：当 SSE 通道断开时，活动流保持最后已知耗时并在标签中标注“连接重连中”，重连成功后静默校准。

---

## 5. 验收标准与验证方案

1. **中断验证**：在启动长任务期间点击红色 `⏹ 中断`，Desktop Codex 端与 Web 控制台能准确中止并记录 `interrupted` 状态。
2. **活动流验证**：任务执行期间，Web 页面实时跳动耗时并展示最新微观活动，任务交付后卡片干净移除。
3. **快捷胶囊验证**：面对多选项提问，助手气泡右下角准确解析并渲染胶囊按钮，轻点即发送指定选项。
4. **双端适配验证**：桌面端左侧轮次轨与移动端右下角轮次指示均可平滑定位历史消息。

