# Sea-Bridge 下一步执行交接（给 Gemini）

> 日期：2026-09-16（Revision 6 补充）  
> 项目：`/opt/app/aitools/sea-bridge`  
> 主设计文档：`docs/telegram-codex-feedback-design.md`  
> 当前阶段：Revision 6 Desktop 消息桥代码已接线，下一步执行 **消息通知与精确回复实机 PoC**。

---

## Revision 6：当前执行入口（优先于后文旧的 Phase 0B 顺序）

用户当前不以 Telegram 审批或 Stop Hook continuation 为验收目标，优先验证以下独立消息桥：

```text
Codex Desktop rollout / state_5.sqlite
  -> Sea-Bridge DesktopObserver
  -> Telegram 状态变化与最终回复通知
  -> 用户回复该通知
  -> SQLite 映射目标 thread
  -> codex queue --thread <threadId> --message <text>
  -> 原 Codex Desktop thread
```

已落地文件包括 `src/desktop/desktop-observer.ts`、`src/desktop/codex-thread-store.ts`、`src/desktop/codex-queue-client.ts`、`src/state/desktop-message-store.ts`、`src/telegram/thread-reply-router.ts`。首次启动基线化已有 rollout，不发送历史消息；新事件会持久化 Telegram notification 与 thread 映射。Telegram 裸文本、未映射回复和重复 update 都不投递。

目标 `0.154.0-alpha.6.2` 的原始 rollout 文件不能按标准 JSONL 解析。观察器现改为读取 `~/.codex/thread_history_1.sqlite` 的 `thread_turns` / `thread_items` 历史投影，游标是 `rollout_ordinal`。通知启用 Telegram 强制回复，确保真实回复包含原通知引用。

已验证：`bun test` 26 passed、`bun run typecheck`、`bun run build`。尚未验证：真实 Desktop 通知和 `codex queue` 的端到端行为。因此必须保持 `DESKTOP_MESSAGE_BRIDGE=pending_poc`。

实机顺序：

1. 重启 Sea-Bridge，确认日志出现启动信息且没有历史 Telegram 补发；
2. 在一个可识别的 Codex Desktop thread 发起新任务，等待其状态变化和最终回复通知；
3. 在 Telegram 中回复这条**本次 Sea-Bridge 通知**一条无害的续问；
4. 记录 `codex queue` 退出状态、Sea-Bridge `telegram_thread_reply_*` 日志、原 Desktop thread 是否显示并处理该回复；
5. 只有第 4 步三项均成立，才将 capability 改为 available，并把版本、脱敏 rollout 结构和测试时间写回主设计文档。

失败时不得把消息改投 Headless 或第二 App Server，也不得继续使用旧 Stop queue 路径掩盖失败。审批/Hooks 章节仍保留在本文供后续独立验证，但不阻塞本消息桥 PoC。

---

## 1. 先读这里：当前真正目标

你的任务不是继续扩业务功能，也不是另起一个 Headless Codex 会话。

Sea-Bridge 的核心目标是：

> **通过 Telegram 控制用户当前已经打开的 Codex Desktop 同一个会话。**

当前已经确认的硬约束：

1. 不修改 ChatGPT/Codex Desktop 的启动环境、启动方式、App Server 拓扑或应用二进制；
2. 不设置 shared-daemon 之类的启动变量，不做 FD 注入/复制；
3. 不用第二个 app-server 的 `thread/resume` 冒充 Desktop live 同会话；
4. 不依赖 GUI 自动点击、AppleScript/CDP 作为正式 V1 主路径；
5. Headless App Server 只能是用户显式选择的辅助任务，不能作为 Desktop capability 的 fallback；
6. Telegram V1 是单用户、单私聊，必须同时校验 `ALLOWED_USER_ID + ALLOWED_CHAT_ID`；
7. Telegram 工作路径不设置 workspace root 白名单，最终受当前 macOS 用户权限控制；
8. 可以修改 Sea-Bridge 自己的代码、`~/.codex/hooks.json` 和自有 Hook wrapper；
9. 未经目标 Desktop 版本真实 fixture 证明的 Hook/IPC 响应一律不能猜测。

如果后续实现与这些约束冲突，优先保留约束，停止实现并记录阻断原因，不要降低需求或静默切换 Headless。

---

## 2. 当前代码已经完成什么

代码工程已经从零初始化完成，主要文件：

```text
src/main.ts
src/config.ts
src/desktop/same-session-adapter.ts
src/desktop/providers/codex-hook.ts
src/desktop/providers/hook-server.ts
src/desktop/approval-coordinator.ts
src/desktop/session-state.ts
src/state/db.ts
src/state/continuation-queue.ts
src/telegram/client.ts
src/telegram/service.ts
src/security/auth.ts
src/security/redact.ts
scripts/codex-hook-bridge.py
scripts/install-codex-hooks.ts
scripts/run-sea-bridge.sh
config/com.sea-bridge.agent.plist.example
config/hooks.example.json
```

已经实现：

- TypeScript + Bun 运行骨架；
- SQLite WAL durable state；
- Telegram long polling、callback、`/status`、user/chat 双白名单；
- Telegram update 幂等；
- `DesktopSameSessionAdapter`；
- `CodexHookProvider`；
- `PermissionRequest -> Telegram Allow/Deny -> Hook output`；
- `Stop -> durable continuation queue -> { decision: "block", reason: ... }`；
- Python Hook stdin/stdout wrapper，通过用户私有 Unix Socket 与 Sea-Bridge 通信；
- Hook transport 不可达时无控制输出、0 退出，回退 Codex 原生行为；
- approval callback opaque token + SHA-256 本地映射；
- approval 状态 `pending -> selected -> delivered/stale`；
- continuation queue SQLite CAS claim / release / consume；
- Hook event 审计与 active-session 证明分离；
- transcript freshness、session/turn 一致性、replay/stale guard；
- Unix Socket 目录 0700、socket 0600、owner/type/symlink/PID-lock 检查；
- Hook 安装脚本：备份并合并现有 `~/.codex/hooks.json`，不覆盖其它 Hook；
- LaunchAgent 示例与用户私有 env 启动脚本。

当前开发环境验证结果：

```text
tsc --noEmit                 PASS
bun test                     12/12 PASS
bun build src/main.ts        PASS
Python Hook wrapper syntax   PASS
Unix Socket wrapper E2E      PASS
```

开始任何修改前，先在项目根目录复跑：

```bash
cd /opt/app/aitools/sea-bridge
bun run typecheck
bun test
bun build src/main.ts --outdir /tmp/sea-bridge-build
```

如果这三项在未改代码前就失败，先查环境差异，不要直接修改业务逻辑来“适配测试”。

---

## 3. 当前 capability 状态

不要把下面的 pending 状态改成 available，除非完成目标 macOS 实机证据：

```text
DESKTOP_APPROVAL           pending_contract   codex_hook.permission_request
DESKTOP_CONTINUATION       pending_poc        codex_hook.stop
DESKTOP_CONTEXT_INJECTION  pending_poc        codex_hook.user_prompt_submit
DESKTOP_IDLE_WAKE          discovery_required
DESKTOP_USER_INPUT         discovery_required
DESKTOP_INTERRUPT          discovery_required
```

完成等级必须诚实表达：

- 只有 `DESKTOP_APPROVAL`：只是远程审批里程碑；
- `APPROVAL + CONTINUATION`：只代表 Codex 仍处于 turn 生命周期时，可以从 Telegram 排队并在同一 Desktop thread 续跑；
- 再完成 `DESKTOP_IDLE_WAKE`：才可以说“Desktop 已 idle 后仍能随时从 Telegram 继续当前会话”；
- `DESKTOP_USER_INPUT`、`DESKTOP_INTERRUPT` 是独立能力，不允许从 Hook 的其它能力推导。

---

## 4. 你接下来必须先做：Phase 0B 实机 Gate

### 4.1 Gate 0：确认目标环境，不先改配置

在目标 macOS 上记录：

```bash
/Applications/ChatGPT.app/Contents/Resources/codex --version
which codex
codex --version
bun --version
python3 --version
```

同时确认：

- Desktop 当前仍是预期的内嵌 Codex 版本（设计文档此前记录为 `0.153.4`）；
- `~/.codex/hooks.json` 是否存在；
- 当前 hooks feature flag / 配置方式是否与目标版本一致；
- `~/.codex/hooks.json` 中是否已经有其它用户 Hook。

**不要因为当前版本和 0.153.4 不一样就强行降级或改 Desktop。** 如果版本变化，先记录新版本并重新导出/核对当前版本 Hook schema，再继续。

### 4.2 Gate 1：先 dry-run Hook 合并

不要直接覆盖 hooks 配置。先执行：

```bash
cd /opt/app/aitools/sea-bridge
bun run scripts/install-codex-hooks.ts --dry-run
```

检查输出：

1. 原有非 Sea-Bridge Hook 是否全部保留；
2. Sea-Bridge 只新增/替换自己的 `codex-hook-bridge.py` entry；
3. `PermissionRequest` timeout 当前为 35 秒，其它事件为 5 秒；
4. command 路径是否指向当前 checkout 的 `scripts/codex-hook-bridge.py`；
5. JSON 结构是否是目标 Codex 版本真正接受的 Hook 配置格式。

如果第 5 项无法从目标版本 schema/实际行为确认，**不要正式安装**，先调整 installer/fixture。

确认无误后才执行：

```bash
bun run scripts/install-codex-hooks.ts
```

脚本会自动备份旧的 `~/.codex/hooks.json`。保存备份路径到测试记录。

### 4.3 Gate 2：先验证 Hook transport，不接 Telegram

先配置一个最小 Sea-Bridge 环境。参考 `.env.example`，但真实 token/ID 不得写入仓库。

至少需要：

```text
TELEGRAM_BOT_TOKEN=...
ALLOWED_USER_ID=...
ALLOWED_CHAT_ID=...
SEA_BRIDGE_DB_PATH=~/Library/Application Support/SeaBridge/sea-bridge.sqlite3
SEA_BRIDGE_HOOK_SOCKET=~/Library/Application Support/SeaBridge/run/codex-hook.sock
```

如果 Telegram 凭据暂时没有，也可以先针对 Hook transport/fixture 做本地验证，但不要把 approval 标成通过。

启动 Sea-Bridge 后检查：

- runtime 目录 owner 是当前用户；
- 目录 mode 是 0700；
- socket 是 Unix socket，不是 symlink/普通文件；
- socket mode 是 0600；
- PID lock 正常；
- 第二个 Sea-Bridge 实例不能抢占正在运行的 socket；
- kill 掉 Sea-Bridge 后，Hook wrapper 不得阻塞 Codex，应 0 退出且不产生控制 JSON。

### 4.4 Gate 3：抓真实 Hook fixture，先不要推断字段

建立 fixture 目录：

```text
tests/fixtures/desktop/codex-hook/<desktop-codex-version>/
```

至少保存以下事件的**真实、脱敏后** payload：

```text
SessionStart
UserPromptSubmit
PreToolUse
PermissionRequest
PostToolUse
Stop
Interrupt（若可触发）
```

每个 fixture 必须记录：

- Desktop/内嵌 Codex 版本；
- Hook event name；
- `session_id`；
- `turn_id`；
- `transcript_path` 是否存在；
- cwd；
- 事件时间；
- Hook wrapper exit code；
- Sea-Bridge response；
- Desktop 最终可观察行为。

不要把完整 secret、环境变量、私有源码、Telegram token 写进 fixture。

如果真实字段和 `src/desktop/hook-types.ts` 不一致，先修类型和 contract test，再继续。

---

## 5. PoC-1：PermissionRequest 远程审批

目标：证明 Telegram 的 Allow/Deny 真正作用于**当前 Desktop 同一个 turn**。

### 5.1 测试步骤

1. 打开一个明确可识别的 Codex Desktop thread；
2. 发起一个会触发 `PermissionRequest` 的安全测试操作；
3. 记录该 Hook 的 `session_id + turn_id`；
4. 确认 Sea-Bridge 创建 Telegram 审批卡片；
5. 点击 Allow；
6. 确认 Hook response 确实写回原 invocation/socket 后，数据库状态才从 `selected` 变为 `delivered`；
7. 确认 Desktop 当前 turn 真正继续；
8. 再做一次 Deny；
9. 再做一次超时不点击，确认系统**不猜测 decision**，按真实目标版本行为回落；
10. 再做 Hook 断连/EPIPE，确认 Telegram 不显示“已成功作用于 Codex”。

### 5.2 通过标准

只有满足以下条件，才能把 `DESKTOP_APPROVAL` 升级为 `available`：

- Allow 作用于原 `session_id + turn_id`；
- Deny 作用于原 `session_id + turn_id`；
- callback 重放无效；
- 断连不会 retarget 后续请求；
- 超时行为已有真实 fixture；
- 历史 Hook replay 不会产生可执行审批；
- 真实 response shape 与当前版本 schema 一致。

通过后补充 contract test，并更新 `docs/telegram-codex-feedback-design.md` 的 capability 状态和实施记录。

---

## 6. PoC-2：Stop -> Telegram queue -> 同 Desktop thread continuation

这是当前最重要的 PoC。

目标：当 Codex Desktop 当前 turn 仍在工作时，从 Telegram 发送下一条要求；Sea-Bridge 将其放入 durable continuation queue；当前 turn 到 `Stop` Hook 时消费该消息，返回目标版本允许的 continuation output；Codex 在**同一个 Desktop thread**里继续执行下一条要求。

### 6.1 必须验证的完整链路

```text
Desktop thread A / turn T1 正在执行
        ↓
Telegram 发“下一步要求 X”
        ↓
Sea-Bridge 确认 A/T1 是最近、真实、fresh 的 active session/turn
        ↓
continuation_queue 写入 X
        ↓
Desktop T1 到 Stop Hook
        ↓
Stop Hook 的 session_id/turn_id 与 active proof 一致
        ↓
CAS claim X
        ↓
返回当前版本真实支持的 continuation/block response
        ↓
Codex 在同一 Desktop thread A 继续执行 X
        ↓
Hook response 实际成功写回后 queue item -> consumed
```

### 6.2 必须同时验证的失败场景

- Stop Hook 已经发生后才从 Telegram 发消息：不能把旧消息错误塞入已结束 turn；
- Desktop 已完全 idle：必须返回 `UNAVAILABLE_DESKTOP_IDLE_WAKE`，不能创建 Headless thread；
- session 切换：A 的 Telegram continuation 不能进入 B；
- turn 切换：T1 的消息不能误进 T2，除非产品明确重新绑定并有新证据；
- Stop response 写 socket 失败：queue claim 必须 release，不能标 consumed；
- 重复 Stop Hook：同一 queue item 只能消费一次；
- Sea-Bridge 重启：未 delivered 的 queue item 不能无条件重复注入；
- `stop_hook_active=true` 时必须按目标版本真实行为处理，不能猜是否允许递归 continuation；
- transcript mtime 旧、session/turn 不匹配、历史 replay：不得消费 queue。

### 6.3 通过标准

只有以下全部满足，才能把 `DESKTOP_CONTINUATION` 升级为 `available`：

- 无 Desktop reload/restart；
- 没有启动第二个 app-server 接管该 thread；
- Desktop UI/rollout 能证明是**同一个 thread**；
- Telegram 文本 X 成为下一条真实 continuation；
- CAS/重试/断连没有双发；
- replay/stale 防护在目标机真实验证通过；
- 当前版本 Stop response fixture 已归档。

如果实际 Desktop 版本的 Stop Hook 不支持 `{ "decision": "block", "reason": ... }` 语义，立即停止该路径，不要为了“让测试过”去伪造协议。

---

## 7. P0：专门验证 0.153.4 附近的 Hook replay / stale 风险

设计文档已经把这一项定为 P0。

需要主动测试：

1. 完成一个有 `PermissionRequest` / `Stop` 的 thread；
2. 等待/触发可能的 compact、memory consolidation 或后台处理；
3. 观察是否再次出现旧 `session_id + turn_id` 的 Hook；
4. 检查 transcript mtime、事件顺序、本地 observed session 状态；
5. 确认 Sea-Bridge 对可疑 replay：
   - 不创建 Telegram Allow/Deny 按钮；
   - 不消费 continuation queue；
   - 记录 `HOOK_REPLAY_SUSPECTED`/stale 类审计；
   - 不修改当前 active session。

如果当前 freshness guard 无法区分真实事件和 replay，不要放宽 guard。应先增加额外事实来源或把 capability 保持 pending/unavailable。

---

## 8. PoC-3：Idle Wake，只做取证，不要先承诺实现

`DESKTOP_IDLE_WAKE` 是当前剩余最大缺口：

> Desktop conversation 已完全 idle，没有 active turn，也没有 Stop Hook 会再触发时，Telegram 如何在**当前 Desktop conversation**创建下一 turn？

调查优先级：

1. 当前 Desktop/Codex 已存在的官方本地 API；
2. Hook 体系是否有当前版本新增事件/response 能完成主动 continuation；
3. app-tools / local-control / MCP 等现有本地通道；
4. 当前 Desktop 用户态 runtime/socket/localhost listener；
5. 上游新版本是否已经提供不改变 Desktop 启动拓扑的官方入口。

禁止作为正式答案：

- 第二个 app-server `thread/resume`；
- 修改 Desktop 为 shared daemon；
- remote-control 需要重写 Desktop 连接配置的方案；
- AppleScript/CDP/GUI 自动点击；
- 直接修改 session JSONL 并要求 Desktop reload；
- 用 Headless 新 thread 冒充当前 Desktop conversation。

如果找不到满足约束的 provider，保持：

```text
DESKTOP_IDLE_WAKE = discovery_required / unavailable
```

并在 `/status` 和主设计文档中明确说明，不要降低产品定义。

---

## 9. Telegram 实机联调

只有在 Bot Token、user id、chat id 已由用户通过本机私有配置提供后执行。

不要要求用户把 Bot Token 发进仓库、日志或文档。

验证：

- 非白名单 user 拒绝；
- 非白名单 chat 拒绝；
- callback 同样重新鉴权；
- `/status` 不泄露 token/secret；
- callback_data 只有短 opaque token；
- duplicate update 幂等；
- Telegram 429/5xx 不造成业务动作双发；
- approval callback 点击后先 `answerCallbackQuery`，但 UI 的“已完成”必须以 Hook delivery 结果为准；
- 普通文本在 active Desktop session 时进入 continuation queue；
- Desktop idle 时返回明确 unavailable，不 fallback Headless。

---

## 10. LaunchAgent 实机部署 Gate

当前模板：

```text
config/com.sea-bridge.agent.plist.example
scripts/run-sea-bridge.sh
```

部署前：

1. 检查 `/bin/zsh` 可用；
2. 给 `SEA_BRIDGE_BUN_BIN` 配置真实 Bun 绝对路径（如果 launchd PATH 找不到 Bun）；
3. env 文件必须只允许当前用户读取；
4. plist 不要内嵌 Bot Token；
5. Sea-Bridge 必须以**当前 GUI 登录用户** LaunchAgent 运行，不要改成 LaunchDaemon/root；
6. 重启 Sea-Bridge 后重新跑 capability/contract gate；
7. 确认 LaunchAgent 重启不会重复消费已 delivered approval/continuation。

不要为了 LaunchAgent 启动方便去修改 ChatGPT/Codex Desktop 的启动环境。

---

## 11. 修改代码时的规则

1. 保持 `DesktopSameSessionAdapter` 为 Telegram 业务的统一入口；Telegram handler 不要直接耦合 Hook socket/SQLite 细节；
2. `CodexHookProvider` 只实现目标版本真实 Hook contract；
3. Hook event 的“审计记录”和“证明 active session”继续分离；历史事件不能自己把旧 session 抬成 active；
4. 写操作必须 fail-closed；transport 故障可以回落 Codex 原生 UI/行为，但不能猜 allow/deny/continuation；
5. approval 只有 response 真正写回 Hook 后才标 `delivered`；
6. continuation 只有 response 真正写回 Hook 后才标 `consumed`；
7. 任何网络/进程断连后，不允许自动重放可能已经生效的写动作；
8. 新增 capability 必须增加：状态、provider、contract fingerprint、fixture、contract/integration test、`/status` 展示；
9. 不要先实现 Headless 来“补齐功能”；
10. 每次修改后至少执行：

```bash
bun run typecheck
bun test
bun build src/main.ts --outdir /tmp/sea-bridge-build
```

涉及 Python wrapper 时额外执行：

```bash
python3 -m py_compile scripts/codex-hook-bridge.py
```

---

## 12. 文档与证据必须同步更新

每完成一个实机 Gate，请同步更新：

```text
docs/telegram-codex-feedback-design.md
```

并保存脱敏 fixture 到：

```text
tests/fixtures/desktop/codex-hook/<version>/
```

建议至少包含：

```text
permission-request.input.json
permission-request.allow.output.json
permission-request.deny.output.json
permission-request.timeout.md
stop.input.json
stop.continuation.output.json
stop-no-queue.output.json
stop-hook-active.md
replay-stale-case.md
environment.md
```

`environment.md` 记录：

- macOS 版本；
- ChatGPT/Codex Desktop 版本；
- 内嵌 Codex 版本；
- 全局 Codex CLI 版本；
- Hook wrapper hash；
- Sea-Bridge commit/hash（若 Git 可用）；
- 测试日期；
- 是否修改过 hooks config；
- 对应 hooks backup 路径。

不要把 secret 写入 fixture。

---

## 13. 遇到以下情况必须停下来，不要自行“修成能用”

以下任一情况出现时，应先记录证据并回到设计判断：

- 目标 Desktop 版本 Hook schema 与当前实现明显不一致；
- `PermissionRequest` 实际不支持当前 output shape；
- `Stop` Hook 的 block/reason 不会形成同 thread continuation；
- Hook replay 无法可靠区分实时事件；
- 同一 Telegram continuation 有双发风险；
- 必须修改 Desktop 启动方式才能继续；
- 必须启动第二 app-server 才能“接同一 thread”；
- 必须使用 GUI 自动化才能实现核心路径；
- 发现任何会让 Allow/Deny 作用到错误 session/turn 的可能性；
- 需要放宽 user/chat 鉴权或 secret 保护才能联调。

正确做法是：保持 capability pending/unavailable，记录原因，更新设计文档，再决定下一步。

---

## 14. 推荐执行顺序

严格按以下顺序推进：

```text
1. 复跑现有 typecheck/test/build
2. 确认目标 macOS Desktop/内嵌 Codex 版本
3. 核对目标版本 Hook schema / feature flag
4. dry-run hooks 合并
5. 安装 Hook（保留 backup）
6. 验证 Unix Socket/Wrapper fail-open
7. 抓真实 Hook fixtures
8. PoC-1 PermissionRequest Allow/Deny
9. Hook replay/stale 专项验证
10. PoC-2 Stop -> queue -> same Desktop thread continuation
11. 真实 Telegram 联调
12. LaunchAgent 实机加载/重启恢复
13. 更新 capability 状态与 Revision 5 Implementation 记录
14. 再开始 DESKTOP_IDLE_WAKE 取证
15. 最后才考虑 DESKTOP_USER_INPUT / DESKTOP_INTERRUPT / Headless 辅助功能
```

不要跳过 7–10 直接宣布功能完成。

---

## 15. 当前交接结论

当前代码已经具备进行目标 Mac 实机 Gate 的基础条件，但**还没有证据证明目标 Codex Desktop `0.153.4` 的真实 Hook contract 与本地 harness 完全一致**。

Gemini 接手后的首要成果不应该是“再写很多代码”，而应该是产出以下三样东西：

1. 一组目标 Desktop 真实、脱敏、可重复的 Hook fixtures；
2. `PermissionRequest` Telegram Allow/Deny 同 turn 的实机通过证据；
3. `Stop -> Telegram continuation queue -> 同一 Desktop thread` 的实机通过或明确失败证据。

只有第 2、3 项通过，才把对应 capability 从 `pending_contract / pending_poc` 升级为 `available`。如果第 3 项失败，保留证据并重新评估同会话 continuation 路线，不得用 Headless 或第二 app-server 掩盖失败。
