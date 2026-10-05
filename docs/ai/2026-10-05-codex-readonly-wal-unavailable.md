# SEA-BRIDGE Codex 暂不可用：现场记录、WAL 原因分析与最终实施规格

记录日期：2026-10-05。现场时间均为北京时间（UTC+8）；日志原始时间为 UTC。

## 1. 问题现象

用户在手机端访问 SEA-BRIDGE v0.14.3 的运行概览，Codex 卡片显示“暂不可用”。随后打开远端 Codex，SEA-BRIDGE 页面又显示来源可用。

截图中的来源采样时间为 **2026/10/5 16:33:39**，各项能力为：

- 会话读取：未就绪。
- 项目目录、模型目录、新建会话：未就绪。
- 历史读取、发送消息：显示“打开 →”。
- 页面提示“部分来源暂不可用，统计仅包含当前返回的会话”。

这些状态并非同一次完整健康检查的结果。来源总状态以会话列表读取是否成功为依据；历史读取标志来自此前成功读取的记录；发送标志来自队列配置。项目、模型目录则需独立访问成功才会标记可读。因此，卡片总状态不能代表所有 Codex 功能同时故障。

## 2. 现场证据与时间线

日志文件：`~/Library/Logs/sea-bridge.error.log`。

| 北京时间 | 证据 | 解释 |
| --- | --- | --- |
| 16:33:39 | 截图采样时间；同一时刻存在数据库读取报错 | 页面不可用与后台读取失败吻合 |
| 16:34:45.201 | 最后一条 `desktop_observer_poll_failed`，错误为 `SQLiteError: unable to open database file` | 之后未再观察到相同报错 |
| 16:34:45 | 当前 `state_5.sqlite-wal` 文件的创建时间 | WAL 文件重新建立与故障结束发生在同一秒 |
| 约 16:38 | 使用项目原有读取模块查询成功，返回 548 个非归档普通会话 | 确认调查时读取已恢复 |

截图时刻的原始日志：

```json
{"ts":"2026-10-05T08:33:39.117Z","level":"warn","event":"desktop_observer_poll_failed","error":"SQLiteError: unable to open database file"}
```

最后一条同类报错：

```json
{"ts":"2026-10-05T08:34:45.201Z","level":"warn","event":"desktop_observer_poll_failed","error":"SQLiteError: unable to open database file"}
```

当日累计检索到 14,638 条同类观察器失败日志。按相邻报错间隔不超过 20 秒划分，最后一段为 14:48:52.692 至 16:34:45.201，共 3,174 条。该划分只是日志分析方法，不能证明更早间隔期间已经恢复。

调查时主数据库仍存在，文件创建时间为 2026-03-13，修改时间为 2026-10-04 23:38:51。主数据库与辅助文件当前归属运行用户，目录具备用户写权限。**这些是调查时的状态，不能直接证明故障发生时的文件和权限状态。**

## 3. 代码调用链

默认数据库路径由 `src/config.ts` 定义为 `~/.codex/state_5.sqlite`，可通过 `SEA_BRIDGE_CODEX_STATE_DB_PATH` 覆盖。

`src/main.ts` 创建 `CodexThreadStore`；该模块的 `listActive()` 与 `getThread()` 均采用：

```ts
new Database(this.path, { strict: true, readonly: true });
```

相关位置：

- `src/desktop/codex-thread-store.ts:54`：单条会话读取连接。
- `src/desktop/codex-thread-store.ts:74`：会话列表读取连接。
- `src/desktop/desktop-observer.ts`：调用 `listActive()`，失败时记录 `desktop_observer_poll_failed`。
- `src/web/sources/codex.ts`：会话读取异常时，将 `sessionsReadable` 置为 false。
- `src/web/status.ts`：调用来源的 `sessions()`；失败时来源状态为 `unavailable`，采样缓存 30 秒。
- `src/web/public/app.js`：将 `unavailable` 渲染为“暂不可用”。

所以页面显示来自本地会话数据库读取失败，而非对模型服务或 Codex 全部能力的综合判断。

## 4. 隔离复现实验

实验环境：当前 Mac，Bun **1.4.2**。实验仅操作新建的临时数据库，没有删除或修改 Codex 原生数据库及其辅助文件。

步骤：

1. 在临时目录建立数据库，启用 WAL，创建表并写入一条记录。
2. 执行 `wal_checkpoint(TRUNCATE)`，将记录落入主数据库，然后关闭连接。
3. 仅删除临时数据库的 WAL/SHM 文件，模拟主数据库存在、辅助文件缺失的状态。
4. 用与项目相同的 `readonly: true` 连接读取。
5. 用可写连接先访问数据库，再次执行只读查询。

| 实验条件 | 结果 |
| --- | --- |
| 主数据库完整，WAL/SHM 缺失；直接只读查询 | `SQLiteError: unable to open database file`，`code=SQLITE_CANTOPEN`，`errno=14` |
| 先由可写连接执行读取，再用只读连接查询 | 成功，记录数为 1 |

可重复执行的实验命令：

```bash
bun --version
bun - <<'JS'
import { Database } from "bun:sqlite";
import { mkdtempSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "sea-sqlite-probe-"));
const path = join(root, "test.sqlite");
const writer = new Database(path);
writer.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE probe(id INTEGER);
  INSERT INTO probe VALUES(1);
  PRAGMA wal_checkpoint(TRUNCATE);
`);
writer.close();

for (const suffix of ["-wal", "-shm"]) {
  if (existsSync(path + suffix)) unlinkSync(path + suffix);
}

function probe(label) {
  let reader;
  try {
    reader = new Database(path, { strict: true, readonly: true });
    console.log(label, reader.query("SELECT count(*) AS n FROM probe").get());
  } catch (error) {
    console.log(label, String(error), error.code, error.errno);
  } finally {
    reader?.close();
  }
}

probe("sidecars_missing");
const opener = new Database(path);
opener.query("SELECT * FROM probe").all();
probe("after_readwrite_connection_access");
opener.close();
JS
```

调查中实际执行的是同一实验的 `bun -e` 形式；上面将脚本展开为便于复用的标准输入形式。实验会留下临时目录。

## 5. 原因分析与结论边界

### 已验证

- 现场报错来自 Codex 本地会话数据库读取。
- 在当前 Mac/Bun 环境，WAL/SHM 缺失足以使项目采用的只读查询方式报同样的 `SQLITE_CANTOPEN`。
- 可写连接先访问数据库后，只读读取可以恢复。
- 现场 WAL 创建时间与最后一次报错处于同一秒。

### 最符合证据的解释

故障时 Codex 数据库的 WAL 相关辅助文件没有处于只读连接可正常访问的状态。SEA-BRIDGE 无法自行完成所需初始化，持续读取失败。用户打开远端 Codex 后，Codex 的数据库连接访问数据库、重新建立辅助文件，SEA-BRIDGE 随后恢复。

**这是受现场时间线、隔离复现和相似案例支持的解释，但现场未记录故障时 WAL/SHM 的存在状态及创建系统调用，仍不能把整条因果链当作完全取证确认。**

### 尚未确定

- WAL/SHM 当时具体缺少哪一个文件，或是否存在其他不可访问状态。
- 哪个进程、哪次操作清理了辅助文件。
- 打开远端 Codex 时具体哪个连接重建了辅助文件。
- 当前行为在 Apple SQLite 与其他 SQLite 构建之间的差异。

不能仅凭当前复现断言这是 Bun 专属缺陷，也不能认定是 Codex 崩溃、主数据库丢失、数据损坏或普通数据库锁竞争。

## 6. 搜索到的类似问题与官方反馈

### 6.1 高度相似：macOS 只读 WAL 查询失败，另一个连接操作后恢复

- 日期：2023-06-25。
- 环境：macOS，SQLite 3.39.0。
- 链接：[SQLite 官方论坛原帖](https://sqlite.org/forum/info/4e3e0509690735bf)。

发帖者将数据库切换为 WAL 模式，之后用 `SQLITE_OPEN_READONLY` 建立第二个连接。查询失败，日志指向无法打开 `test.sqlite-wal`；第一个连接执行写操作后，第二个连接恢复。

回复者 Keith Medcalf 解释：数据库连接建立不一定立即创建 WAL，需要实际访问数据库；只读连接在 WAL 尚未建立时无法创建它。此反馈与本次隔离实验高度一致。该回复是官方论坛参与者的分析，不等同于 SQLite 或 Bun 发布的缺陷修复公告。

### 6.2 相似但原因不同：目录可写仍无法只读访问 WAL 数据库

- 日期：2020-05-26。
- 环境：macOS，手工编译 SQLite。
- 链接：[readonly access to WAL database](https://sqlite.org/forum/info/b287de44c828fa60)。

发帖者在主文件和目录具备写权限的情况下，只读访问仍报 I/O 错误；其后发现默认使用 `locking_mode=EXCLUSIVE`。这个案例说明，操作系统文件权限并不能单独决定只读 WAL 是否成功，构建及连接配置也会影响行为。

该案例错误和配置与本次不同，不能用它认定 SEA-BRIDGE 使用了 EXCLUSIVE 模式。

### 6.3 SQLite 官方说明

- [WAL 只读数据库条件](https://www.sqlite.org/wal.html#read_only_databases)。
- [WAL 文件生命周期](https://www.sqlite.org/walformat.html)。

官方文档说明，只读访问 WAL 数据库需要满足条件之一：辅助文件已存在且可读、具备创建辅助文件的条件，或数据库以 immutable 方式打开。文档还说明最后一个连接正常关闭时可能执行 checkpoint 并清理 WAL/SHM；持久 WAL 配置可以改变此行为。

### 6.4 Bun 官方说明

- [Bun SQLite 文档：WAL sidecar file cleanup](https://bun.sh/docs/runtime/sqlite#wal-sidecar-file-cleanup)。

Bun 文档说明 macOS 默认使用系统 SQLite，Apple 构建启用了持久 WAL，辅助文件通常在关闭后保留；Linux/Windows 使用 Bun 自带构建，清理行为不同。

### 搜索结论

已找到高度相似的 macOS/SQLite 原始报告与机制说明。此次检索未找到 Codex 或 Bun 专属、与本次完全一致且已确认的 issue。未找到不代表不存在。

## 7. 最终架构裁决

### 7.1 核心结论

正式修复不再围绕 WAL workaround 展开。SEA-BRIDGE 应把 **Codex 官方 app-server 作为 thread catalog 与 Telegram terminal-turn history 的主读取边界**，直接退出这两条链路对 `state_5.sqlite`、`thread_history_1.sqlite` 的依赖。

本服务为单人自用服务，可以接受一次计划内停机升级。因此迁移策略按最小复杂度设计：

> **停止 SEA-BRIDGE → 重新初始化 Codex observer 本地状态 → 启动新 ReadService/Observer。**

不做运行时双读、双写、V2 表、旧新 observer 并行 ownership、shadow/cutover fencing、长期 SQLite compatibility fallback，也不迁移 Codex/DSH 的业务数据。

保留四个核心组件：

1. 长生命周期、只暴露查询方法的 `CodexReadService`；
2. 独立短生命周期的 `CodexActionService`；
3. SEA-BRIDGE 自己维护的 Last-Known-Good（LKG）catalog；
4. 基于 `threadId + turnId` 的 terminal observation、turn anchor 与现有 outbox。

### 7.2 “重新初始化”具体含义

Codex thread/history 的事实来源是 Codex；DSH 数据来源是 DSH。SEA-BRIDGE 本地数据库保存的是集成运行状态，不需要把这些运行状态全部当成必须迁移的业务数据。

本次升级：

**保留：**

- `desktop_message_links`：旧 Telegram 消息仍可回复到原 thread；
- `desktop_notification_outbox`：升级前已经持久化但尚未发送的通知继续重试；
- Telegram delivery、账号、偏好、审批、DSH 等其他 SEA-BRIDGE 状态；
- DSH 的所有表和游标。

**重新初始化：**

- 旧 `desktop_observer_cursors` 的 ordinal/byteOffset 语义；
- 新 observer 所需的 turn anchor、pending turn、内容 settle 状态；
- Codex catalog LKG 可从官方 `thread/list` 重新构建，无需从旧 `state_5.sqlite` 搬数据。

因此无需做旧 ordinal → turnId 的复杂数据迁移，也无需双读两代表。

### 7.3 停机窗口与通知 SLA

采用重新初始化后，要明确接受一个产品边界：**SEA-BRIDGE 停止到新版本持久化 `bootstrap_started_at` 之前，不提供 terminal 通知完整性 SLA。** 这段窗口内已经完成的 turn 可作为既有历史 suppress，不补发。

`bootstrap_started_at` 一旦持久化，所有外部 thread 的初始化事件分界统一从该时间开始：即使某个 thread 尚未完成自身 baseline，只要后续能从官方历史中读到 `completedAt >= bootstrap_started_at` 的 terminal，就必须补发；不能因为 baseline 较晚而把它当成历史。某个 thread baseline 原子提交成功后写入 `monitoring_started_at`，它只表示该 thread 已进入正常实时监听，不再承担历史/新事件的时间分界。

全局 bootstrap 只表达“初始 thread 集合已经完成第一轮处理”，不能代替逐 thread 的实时监听状态。个别 thread 长期不可读时，其他已经 baseline 的 thread 继续工作，全局通知状态进入 `degraded`，不能永远停留在 `initializing`。

这是自用服务下有意接受的简化。升级应选择没有重要 Codex 任务运行的时间进行。如果希望升级窗口也做到零漏通知，就必须重新引入复杂 cutover；本方案明确不做。

## 8. 目标协议与环境边界

实现绑定项目实际解析到的 Codex CLI。

2026-10-05 目标机已验证：

- `resolveCodexCli()` 解析到 `/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex`；
- 捆绑 CLI 为 **0.160.0**；
- PATH 中全局 `codex` 为 **0.147.0**；
- 捆绑 CLI 生成 schema 中存在 `thread/list`、`thread/turns/list`、`thread/items/list`、`useStateDbOnly`；
- 真实 `thread/list` 能返回 100 条及下一页 cursor；
- 真实 `thread/turns/list` 能返回分页结果。

启动时记录：

```text
resolvedCliPath
cliVersion
protocolSchemaFingerprint
CODEX_HOME
```

所有会访问 Codex 本地状态的 CLI 子进程都必须显式传入同一 `config.codexHome` 作为 `CODEX_HOME`，包括 `CodexReadService`、`CodexActionService` 和 `ProcessCodexQueueClient`。这里要求的是**真正注入 child process env**，不是只把 `codexHome` 传给上层 options。当前 `CodexAppServerClientOptions.codexHome` 主要用于权限解析，`defaultSpawner()` 仍直接继承父环境；queue client 也直接 `spawn(codexCliPath, ["queue", ...])`。两条 spawn 路径都必须改为显式 `env: { ...process.env, CODEX_HOME: config.codexHome }`（或等价注入），否则可能出现“权限解析/读取认为环境 A，实际 app-server/queue 运行在环境 B”的分裂状态。

同时要解除 `codexHome` 对 `SEA_BRIDGE_CODEX_STATE_DB_PATH` 的隐式依赖。当前 `src/config.ts` 使用 `dirname(codexStateDbPath)` 推导 `codexHome`；当 `state_5.sqlite` 读取被删除后，应改为直接使用 `CODEX_HOME`，未配置时默认 `~/.codex`。`SEA_BRIDGE_CODEX_STATE_DB_PATH` 与 `SEA_BRIDGE_CODEX_THREAD_HISTORY_DB_PATH` 在对应旧 Store 删除后一起废弃，不能继续充当环境定位参数。

## 9. `CodexReadService`

### 9.1 生命周期与 API

SEA-BRIDGE 启动一个长期复用的：

```text
codex app-server --stdio
```

完成 `initialize → initialized` 后执行 capability probe，确认所需方法和关键字段可用，再进入 READY。

公共 API 只提供强类型查询：

- `listThreads()`；
- `getThread()`；
- `listTurns()`；
- `listItems()`；
- `listProjects()`；
- `listModels()`。

不公开通用 `request(method, params)`。运行时仍检查查询方法白名单。读取 session 的 inbound request handler 与 Action 审批 handler 分离，读取 session 收到动作/审批请求时拒绝处理。

### 9.2 supervisor

长期子进程至少支持：

```text
STARTING → READY → DEGRADED → RESTARTING → READY
```

传输/进程级错误才触发重启：子进程退出、stdio 断开、初始化失败、无法恢复的 JSON/framing 错误、连续连接级失败。

单个业务 RPC 错误、method 不支持、参数错误和一次 timeout 不直接重启。method 不支持进入 `protocol_incompatible`。

实现资源上限：并发请求数、排队长度、stdout 未完成单行 buffer、单条 JSON 消息大小、pending request 数。stdout framing 必须先按换行消费已经完整的 JSON 行，再检查剩余未完成单行的 buffer；不能用“当前 chunk + buffer 总长度”判断超限，否则一个 chunk 中包含多条正常消息时会误触发重连。单条 JSON 仍保持有限上限（当前默认 8 MiB，并允许 ReadService options 调整），历史类 RPC 默认分页大小使用 25，避免 100 条 items/turns 聚合成过大的单次响应。连接使用 generation，旧连接的迟到结果不得写入新状态。重启使用指数退避 + jitter，shutdown 后不再重启。

为避免为了并发正确性再引入复杂 fencing，读取调度采用两个简单 single-flight 约束：

- catalog 写入串行化：完整扫描、热页刷新和手动 catalog refresh 不能并发提交；重复请求只复用或排队同一个刷新任务；
- 同一个 thread 的 history refresh 串行化：同一时刻最多一个扫描可以计算并提交该 thread 的 observation/anchor；不同 thread 仍可在全局并发上限内并行。

这样可以直接消除“旧 full scan 覆盖新热页”和“两个 history scan 竞争推进 anchor”的竞态，不需要额外的 catalog/owner epoch。

### 9.3 异步 RPC 与本地 catalog 的接口边界

现有 `CodexThreadReader.listActive()/getThread()` 是同步接口，而 app-server RPC 天然异步，不能把远端 RPC 硬塞回这个同步契约。

实施时拆成两层：

- `CodexReadService`：异步 RPC，负责 `thread/list`、`thread/read`、`thread/turns/list`、`thread/items/list` 等当前事实读取；
- `CodexCatalogStore`：SEA-BRIDGE 本地 catalog/LKG，提供已观测快照、标题和 rolloutPath 等缓存 metadata。

调用规则：

- Web 会话列表、Telegram 展示标题、queue diagnostics 等允许使用本地 catalog snapshot；
- 需要当前协议事实的读取显式 `await CodexReadService`，不能伪装成同步 `getThread()`；
- `CodexWebSource`、`TelegramService`、queue diagnostics 等现有 `CodexThreadReader` 调用点要逐一改造，不能保留一个内部偷偷发 RPC 的同步 adapter；
- `CodexThread.rolloutPath` 改为可空，本地 catalog 中路径缺失只影响 rollout 相关能力，不影响 thread 本身存在。

这样既保留 LKG 的降级价值，也不会让不同调用点各自绕过 ReadService 发起未受控 RPC。

## 10. Thread catalog：`thread/list` + LKG

### 10.1 完整分页

行为上显式指定：

- `archived:false`；
- `sortKey:recency_at`；
- `sortDirection:desc`；
- 明确普通 thread `sourceKinds`；
- `useStateDbOnly:true`；
- limit 使用协议允许值。

不得依赖默认 source 集合，也不能把 subagent 扩大到用户会话列表。catalog adapter 还必须保持现有产品语义：

- 只展示未归档普通 thread；
- 标题继续按“明确名称/上游可用标题 → `未命名会话 · ID 后八位`”回退，字段缺失不能导致 thread 消失；
- 创建来源继续归一化为 Desktop、CLI、Sea-Bridge、Exec、未知，保持当前“优先可信 originator/source 证据，无法识别则 unknown”的保守策略，不能根据当前执行进程猜测创建来源；
- app-server 返回的原始来源字符串不直接泄漏到 Web/Telegram UI，仍经过 SEA-BRIDGE 的 provenance 归一化边界。

完整扫描写入临时集合，所有页成功后才提交：

```text
page 1..k
→ threadId 去重
→ 检测重复 cursor / 页数 / 总耗时
→ 所有页成功
→ commit catalog generation
```

任一页失败时保留旧 LKG，不因为失败扫描删除 thread。热页刷新只能 merge，不能删除冷会话。catalog 刷新按第 9.2 节 single-flight 串行提交，因此不允许一个更早开始的 full scan 在更晚的热页刷新之后反向覆盖状态。

由于 recency 排序分页不是事务快照，对本轮“消失”的 thread 采用保守策略：至少下一轮完整扫描再次缺失后再移出 active catalog；重新出现时允许恢复。缺失计数/候选状态需要持久化到 LKG 或 catalog 状态中，进程重启不能把“一次缺失”误当成“两次确认”。

### 10.2 LKG

LKG 持久化到 SEA-BRIDGE 自己的状态库，至少记录：

```text
snapshotSchemaVersion
resolvedCliPath
cliVersion
protocolSchemaFingerprint
codexHomeIdentity
catalogGeneration
fullReconciledAt
completeness
```

每个 thread 记录 `observedAt`。LKG 只保存/表达 catalog metadata（threadId、标题、更新时间、来源、可用 rolloutPath 等最近观测事实），不能把旧的 `running/idle/waiting_external_approval` 当成当前状态，也不能被当作实时 ownership 证据。Web 展示 stale LKG 时，session execution state 必须重新由当前 approval/Action ownership/hook/activity 证据计算；没有当前证据就返回 `unknown`，不能沿用缓存中的旧运行态。

动作按最终接纳者区分：

- `openDesktop` 等要求确认当前 thread 存在的 UI 动作，ReadService 可用时应实时查询；无法确认时返回 `target_unconfirmed` / `source_unavailable`；
- Telegram reply 的 `threadId` 来自服务端持久化 `desktop_message_links`，属于可信 durable target，可直接尝试 queue，不额外强制依赖 ReadService 健康；`ProcessCodexQueueClient.queue()` 的实际退出状态/receipt 是最终接纳结果；
- Web `send(id, ...)` 的 `id` 来自客户端请求，不能因为简化架构就取消服务端目标校验。至少要求该 id 存在于**同 codexHomeIdentity 的服务端 CatalogStore/LKG**，或由当前 ReadService 实时确认；stale LKG 在这里仅证明“SEA-BRIDGE 曾在当前环境观测到该 target”，不证明它当前仍可执行，最终仍由 queue CLI 返回接纳/失败；
- 所有动作都不能因为 stale LKG 就宣称“已确认可执行”，LKG 最多用于展示和目标定位。

LKG 必须按环境隔离：`codexHomeIdentity` 不一致时旧快照完全不可加载；CLI/version/schema fingerprint 变化但 `codexHomeIdentity` 相同时，旧快照最多作为 `stale` 展示，完成一次新协议成功刷新前不能标为 `ready`。

app-server 不可用且有同环境 LKG 时 catalog=`stale`；没有可用 LKG 时 catalog=`unavailable`。**不再回退读取 `state_5.sqlite`。**

## 11. Observer 正确性与调度

`recencyAt` 是秒级、可为 null 的排序字段，只能作为调度提示，不能作为事件版本号。

规则：

- 新 thread 或 recency 变化进入刷新集合；
- running turn 持续刷新直到 terminal；
- terminal 已出现但最终正文未确认时继续刷新；
- 查询/持久化失败时 pending 不清除；
- 周期性历史 reconciliation 不受 recency 是否变化限制；
- 最新 100 条热集仅用于性能优化；
- `recencyAt=null` 也必须按时间调度历史补查；
- 冷会话默认每 5 分钟至少进行一次有界 history reconciliation，可配置但必须有有限上界；
- pending/running/pending-content 使用更快的 poll；
- 同一个 thread 的刷新使用 single-flight；后续触发在已有刷新运行时只标记 `refresh_again`，当前刷新结束后最多再执行一次合并刷新；
- thread 即使从 active catalog 消失，只要已经进入 observer state，就继续按持久 anchor 做冷 reconciliation；存在 running/pending-content observation 时使用更快刷新。不能仅因为目录消失就停止历史补查，否则“完成后立即归档”的 terminal 可能永久漏通知。

调度器必须做公平配额，而不是简单按热集插入顺序截断：pending/running/pending-content 属于 urgent due，优先获得处理槽位；已到期的冷会话 reconciliation 保留独立配额；changed-hot 也保留最小配额，避免反向饿死新活动会话。默认 `refreshBatch=20` 时，冷补查和 hot 各至少预留约 1/4 容量，剩余优先给 urgent；某类为空时其容量可被其他类使用。已处理 due 会推进 `nextHistoryReconcileAt`，未处理的 overdue 保持更早 deadline，因此连续负载下会自然轮转，不能由固定 thread 顺序永久占满槽位。

## 12. 历史、Web 与 rollout 边界

Telegram observer 的 terminal-turn 来源迁移到 `thread/turns/list` / `thread/items/list`，不再使用 `ThreadHistoryStore`。

本阶段仍允许以下已有依赖继续存在：

- `src/web/codex-transcript.ts` rollout JSONL 历史；
- `readCodexActivity()`；
- `readCodexMessage()`；
- `readCodexAttachment()`；
- `readQueueExecutionEvidence()`；
- `readRolloutOpenPids()`；
- `queue_1.sqlite`；
- `Thread.path` / `rolloutPath`。

所以本次只解决 catalog 与 Telegram observer 的两个私有 SQLite 依赖。Web 历史、附件、活动和 queue diagnostics 的迁移后续单独设计，不在本次扩大范围。

这意味着 app-server catalog adapter 仍需要把官方 `Thread.path` 映射为当前代码使用的 `rolloutPath`。`Thread.path` 缺失、无效或不满足现有 root confinement 时，**不能因此把 thread 从 catalog 删除**；应保留会话本身，只把该 thread 的 Web history/attachment/rollout diagnostics 标记为不可用。`CodexThread.rolloutPath` 因此需要改成可空语义，所有 rollout 调用点显式处理缺失路径。

## 13. 通知正确性模型

### 13.1 每个 turn 只有一个**确认后的** terminal 事件

确认后的 terminal 业务身份定义为：

```text
(threadId, turnId)
```

`terminalKind = completed | failed | interrupted` 是结果属性。`finalText`、hash、observedAt 不改变业务身份。

但官方只读 app-server 在另一个进程仍持有/执行 turn 时，可能暂时把该 turn 投影成 `interrupted`。因此 **`status=interrupted` 本身不是足够的 terminal 证据**。当 `interrupted` 同时满足“`completedAt` 缺失、没有 `final_answer`、没有同 turn 的近期 `Interrupt` Hook 证据”时，observer 必须把它保存为 `terminal_kind=NULL + content_state=pending` 并继续 reconciliation，不能入 outbox，也不能封死后续 `completed`。

`interrupted` 只有在至少满足一项可靠证据时才可确认：官方 turn 带 `completedAt`、读到真正 `final_answer`、或近期 Hook 对同一 `turnId` 明确观察到 `Interrupt`。同 turn 的近期 `active` Hook 证据应强化“继续等待”的结论；没有 Hook 证据也不能反过来把无时间戳/无正文的 `interrupted` 自动确认。

普通确认后的 terminal 仍保持单次身份：互相矛盾的 completed/failed/interrupted 默认进入异常 reconciliation，不能随意生成第二条 terminal 通知。唯一窄例外是修复历史误判：如果本地已经存在旧 `interrupted` terminal identity，而官方后来明确返回 `completed`，且 `completedAt` 或真正 `final_answer` 至少有一项完成证据，则允许发送一次 `interrupted → completed` correction。该 correction 使用独立稳定 fingerprint；已发送的旧 interrupted link 保留，未发送的旧 interrupted pending outbox 被原子替换，之后 completed 再次出现必须去重。这个例外不是通用“多 terminal”能力。

### 13.2 本地 observation

新增单一正式表（不使用 V2 命名）：

```text
desktop_turn_observations
- thread_id
- turn_id
- last_status
- terminal_kind nullable
- content_state
- disposition
- final_text_hash nullable
- terminal_first_observed_at nullable
- settle_deadline_at nullable
- first_observed_at
- last_observed_at
PRIMARY KEY(thread_id, turn_id)
```

字段语义固定，避免实现时再次发散：

- `content_state`: `not_applicable | pending | ready | confirmed_empty | timeout_unconfirmed`；
- `disposition`: `monitoring | baseline_suppressed | already_known | notification_enqueued`。

observation 保存事件事实和处理边界，不承担 Telegram 发送状态。投递的 `pending/sent/attempt_count/message_id` 继续由现有 `desktop_notification_outbox` 与 `desktop_message_links` 管理。

`event_fingerprint` 改为稳定地由 `threadId + turnId + terminal` 生成，不再包含 ordinal/finalText。当前部署只有一个允许的 Telegram chat，因此现有全局 fingerprint 唯一性足够，不引入多目标通知模型。

### 13.3 terminal 正文延迟

状态：

```text
running
→ terminal_pending_content
→ terminal_ready
→ outbox_enqueued
```

terminal 后正文尚未确认时持久化等待状态和 `settleDeadlineAt`。重启不能重置 deadline。

必须区分：

- 完整读取 items 后找到 `phase=final_answer` 的 agentMessage；
- 只读到 `phase=commentary`/其他明确非 final phase，**不能**把它作为最终回复；
- 完整读取 items 但当前没有 final answer；
- items 尚未加载/响应不完整；
- RPC/分页读取失败。

兼容旧协议时只允许一个保守 fallback：如果该 turn 读取到的所有 agentMessage 都完全没有 `phase` 字段，可把最后一条 phase-less agentMessage 作为 legacy final candidate；一旦同一 turn 出现任何带 phase 的 agentMessage，就禁止使用 phase-less fallback。phase 是否存在必须在正文有效性和长度过滤之前判定：即使 phased message 的正文为空白、无效或超过本地长度上限，也仍然足以关闭 legacy fallback。这样现代协议中的 commentary 永远不会被升级成 terminal 正文。

正文读取不能只看 `thread/items/list` 第一页。对目标 turn 要按 cursor 完成有界分页，检测 cursor 循环、页数和消息大小上限；只有所有需要的页成功返回后，才能认定本次 item view 完整。任一页失败都保持 `pending`。

对于 `completed` turn，第一次“完整但没有 final answer”仍可能是落盘时序，因此至少再进行一次成功的完整 items 读取，或等待到 settle deadline，再转为 `confirmed_empty`/无正文通知。`failed` 在 terminal 信息已稳定且没有可用正文时可以直接形成无正文通知。

`interrupted` 单独处理：只有第 13.1 节定义的可靠终态证据成立后，才允许形成 interrupted 通知；“无 `completedAt` + 无 final answer + 无 exact Interrupt Hook”的 interrupted 即使超过普通 settle deadline，也仍保持 pending，不得因为超时自动升级成终态。这样避免独立读取进程把另一个进程仍在执行的 turn 提前判死。

items 尚未加载、响应不完整和读取失败都不能当成“没有正文”。达到 settle deadline 后允许 `completed` 发送一次无正文状态通知，并记录 `timeout_unconfirmed` 原因；`interrupted` 不适用这一自动确认规则。通知正文一旦入 outbox 就冻结，重试期间不修改。

### 13.4 turn anchor

分页 cursor 只用于单轮翻页，不持久化为跨重启游标。

每个 thread 的 observer state 至少保存：

```text
anchorTurnId
nextHistoryReconcileAt
```

pending turn 由 `desktop_turn_observations` 中非最终处理状态推导，不需要额外存 JSON 列表。

刷新时从最新 turn 向旧扫描，至少满足两个停止条件后才能结束：

1. 找到并重新处理旧 `anchorTurnId`，再读取固定 overlap；
2. 本 thread 所有仍处于 `monitoring/pending` 的已知 turnId 都已在本轮找到并刷新，或已通过同一协议的直接 item/status 查询得到等价证据。

这样即使一个 pending turn 因为大量新 turn 滑出 overlap，也不会被永久遗忘。只有本轮需要的页全部成功、旧 anchor 找到且 observation/outbox 已事务提交后，才能推进新 anchor。

如果 thread 在建立正式监听时没有任何 turn，则允许 `anchorTurnId=NULL`。之后首次看到 running turn 时直接进入 monitoring；首次看到 terminal turn 时，严格以持久化 `monitor_from_at` 分类：明确早于该边界的属于初始化窗口历史，可 suppress；等于/晚于边界的按新事件处理；时间缺失或边界秒歧义时按“宁可重复一次也不静默漏通知”处理并记录 warn。`monitor_from_at` 缺失属于本地状态错误，应将该 thread 标记 deferred/不可确认，不能 fallback 到较晚的 `monitoring_started_at`。

找不到已有 anchor、找不到必须刷新的 pending turn，或任一分页失败时都不推进 anchor，转入更深 reconciliation。深度补查遇到旧历史时同样使用 `effectiveMonitorFrom` 作为时间边界，避免 anchor 丢失后把安装前历史重新通知。

### 13.5 本地事务边界

远端 RPC 在 SQLite 事务外完成。本地一次事务中：

1. upsert observation；
2. 对 ready terminal 按 `(thread_id, turn_id)` 查询全部历史 `desktop_notification_outbox` 与 `desktop_message_links` 中 `event_kind IN ('completed','failed','interrupted')` 的 terminal 身份，不限定当前 `allowedChatId`；已存在则把 observation 标为 `already_known`；
3. 不存在时用稳定 fingerprint 执行 `INSERT OR IGNORE` 写现有 outbox，并把 observation 标为 `notification_enqueued`；
4. 更新 thread anchor/reconcile 时间。

这里读取的“旧/新”指同一张现有 outbox/link 表中的历史记录和新记录，不是双表/双写。不能只调用现有 `hasEventFingerprint()`，因为旧版本 fingerprint 包含 ordinal/finalText，与新稳定 fingerprint 不同。

不能先推进 anchor 再写 outbox。anchor 可以在 running 或 pending-content observation 已持久化后前进，内容 settle 不应阻塞后续 turn 的边界推进；这些未完成 turn 由 observation 独立持续追踪。

## 14. 一次性重新初始化规则

### 14.1 不做旧 ordinal → turnId 数据迁移

旧 `desktop_observer_cursors.byte_offset` 是 `thread_history_1.sqlite` ordinal，和官方 Turn 没有稳定一一契约。既然允许停机，本次不做转换，新 observer 也不再运行时读取该表。

为了避免在旧表上做破坏性改列，本次直接新增两张**单一正式表**，不使用 V2 命名：

```text
desktop_observer_meta
- singleton_id = 1
- schema_version
- schema_initialized_at
- codex_home_identity
- bootstrap_started_at
- bootstrap_initial_pass_completed_at nullable
- bootstrap_catalog_generation nullable

desktop_observer_state
- thread_id PRIMARY KEY
- bootstrap_member
- baseline_state            # pending | monitoring | deferred
- anchor_turn_id nullable
- monitoring_started_at nullable
- monitor_from_at NOT NULL
- next_history_reconcile_at
- last_reconciled_at nullable
- first_discovered_at nullable
- last_error nullable
- updated_at
```

同时创建第 13.2 节的 `desktop_turn_observations`。旧 `desktop_observer_cursors` 保留但彻底停用，不参与任何双读；验收稳定后可在单独清理中删除。这样既没有兼容路径，也避免为了“重置”去改写一张旧 schema 表。

第一次进入新 observer schema 时，在一个事务中创建上述表并写入 `schema_version/schema_initialized_at/codex_home_identity`。这个标记只表示新本地 schema 已就绪，不表示 baseline 已完成。事务失败整体回滚；已提交后普通重启、ReadService 重连、Codex CLI 升级都不得重新清空 `desktop_observer_state` 或 `desktop_turn_observations`。

observer 状态与 LKG 一样绑定 `codexHomeIdentity`。启动 observer 前先比较当前 `config.codexHome` 的规范化 identity 与 `desktop_observer_meta.codex_home_identity`：一致才允许继续使用现有 anchor/observation；不一致时停止 Codex observer，并同时把依赖当前 Codex 环境的 create/open/queue 动作标记为 `reinitialize_required`/不可用，提示执行一次定向重新初始化。**不得自动清空旧 observer 状态，也不为多 CODEX_HOME 引入多套 observer 表。**

同一 CODEX_HOME 内的本次 schema 升级继续保留 Telegram link/outbox。**CODEX_HOME 切换不作为日常热切换功能支持**，identity 检查只负责 fail-closed 防止误用旧状态。真要切换到另一个 CODEX_HOME，按人工维护重置处理：旧 `desktop_message_links` 中的 threadId 属于旧环境，不能继续作为新环境的 queue 目标；先保持 Codex create/open/queue 禁用并让旧 Codex `desktop_notification_outbox` pending 记录排空，再清理旧 Codex reply link 以及与旧环境绑定的 observer/运行中临时状态，写入新 `codex_home_identity` 后重新 bootstrap。DSH 使用独立表，不受影响。这样无需给历史 link/outbox 增加环境列，也不会为了罕见的环境切换引入多套状态表。

schema 初始化与 bootstrap 是两个阶段：schema 已完成但 baseline 未完成时，重启只续做 baseline。baseline suppression 只允许发生在明确的初始化时间边界；正常运行故障恢复必须从持久 anchor、observation 和 `monitor_from_at` 补查，不能用较晚的 `monitoring_started_at` 重新定义事件边界。

这属于 **Codex observer 状态重新初始化**，不是 Codex/DSH 业务数据迁移。

### 14.2 同一 CODEX_HOME 升级时保留旧 Telegram link/outbox

本次同一 CODEX_HOME 内升级不重建：

- `desktop_message_links`；
- `desktop_notification_outbox`。

若是主动切换 CODEX_HOME，则按第 14.1 节环境切换规则处理，不适用本节的 link 保留规则。

这样：

- 旧 Telegram 通知仍能回复；
- 升级前已经持久化的 pending 通知仍能发完。

新 observer baseline 时先读取这两个表中的已有 `turn_id`，这些 turn 直接视为已知事件，避免已经发过/待发的事件在新模型下再次生成。

上述“已知事件”筛选所有历史 `event_kind IN ('completed','failed','interrupted')` 且 turn_id 非空的 link/outbox，并以 `(thread_id,turn_id)` 匹配，不限定当前 `allowedChatId`。本服务的 terminal 业务身份是全局的；仅仅修改目标 chat 配置不能让一个已处理 turn 重新变成“未通知事件”。实际 pending outbox 仍发送到记录自身保存的 `telegram_chat_id`。现有 links 也可保存 started、reply_prompt、thread_created 等事件；这些记录不能抑制未来 terminal 通知。保留旧 fingerprint、消息 ID、正文和重试时间，不为旧 outbox 重算 fingerprint，也不重建这些记录。

旧 terminal outbox 的 pending/sent 与 links 仅用于建立去重事实；不能因为非终态 link 或相同 turnId 出现在其他 thread，就标记 already_known。重新初始化后正式入队仍需事务内检查该 terminal 身份，避免新 fingerprint 与旧 fingerprint 不同而插入第二份 outbox。

### 14.3 Baseline

首次启动新 observer 时，**先在本地事务中持久化一次且仅一次的 `bootstrap_started_at`**，再发起首次全量 `thread/list`。这个时间点定义本次初始化通知边界，不能等 catalog 扫描完成后才补写；否则扫描期间新建并完成、又未进入冻结集合的 thread 可能被错误当成初始化前历史。

首次全量 `thread/list` 成功后再**冻结初始集合**：在本地事务中写入 `bootstrap_catalog_generation`，并为该次成功扫描得到的 active thread 创建 `desktop_observer_state(bootstrap_member=1, baseline_state='pending', monitor_from_at=bootstrap_started_at)`。后续新建 thread 不再扩大这个初始集合。若首次 catalog 扫描失败，保留原 `bootstrap_started_at` 重试，不能每次失败后刷新时间边界。

冻结初始集合主要用于初始化进度统计；**有可靠 `completedAt` 时**，无论 thread 是否属于初始集合，都统一以持久化 `bootstrap_started_at` 作为时间边界。唯一例外是目标协议对旧 terminal 可能不返回 `completedAt`：冻结初始集合在首次 baseline 中第一次看到、且此前没有该 turn observation 的无时间戳 terminal，必须按历史快照 suppress，不能因为时间缺失就批量补发旧通知。这样既避免首次部署历史洪泛，又不影响已经观察到 running 的 turn 后续正常完成通知。

每个初始 thread 独立 baseline，规则固定为：

1. 使用目标协议确认的倒序 `thread/turns/list` 读取最新 turn。只有在目标 CLI 实测确认“同一 thread 同时最多一个非终态 turn，且该非终态 turn 必定位于最新页”后，baseline 才允许只读取最新一页；若无法证明这一不变量，必须继续分页直到确认不存在更旧的非终态 turn，不能为了省 I/O 假设它不存在；
2. **所有本次 baseline 已成功读取页**中的 terminal turn 先查旧 link/outbox：已知 terminal 写为 `already_known`；否则按 `completedAt` 与持久化 `bootstrap_started_at` 分类——明确早于边界的写 `baseline_suppressed`，等于/晚于边界的进入正常 terminal 处理并允许通知。若这是冻结初始集合的首次 baseline、该 turn 此前没有 observation 且 `completedAt` 缺失，则按历史快照写 `baseline_suppressed`；只有此前已经观察到该 turn 为非终态，才允许在 `completedAt` 缺失时按监控期 terminal 正常通知；
3. **所有本次 baseline 已成功读取页**中的非终态 turn 都写入 `monitoring`，后续 terminal 必须正常通知；不能只追踪第一页，否则多页回退本身失去正确性价值；
4. `anchor_turn_id` 设置为本次已成功读取的最新 turn；若 thread 没有任何 turn，则允许 anchor 为 NULL；
5. observation、anchor、`baseline_state='monitoring'` 和 `monitoring_started_at` 在同一个本地事务中提交；从这个提交点开始该 thread 进入正常实时轮询，但事件分类边界仍保持原 `monitor_from_at`，不得被 `monitoring_started_at` 后移；
6. baseline RPC 失败只把该 thread 保持/标记为 `deferred` 并记录错误，不能清除其他 thread 的 monitoring 状态。

如果目标 CLI 无法保证 turns 的倒序语义，capability probe 必须直接失败，不能靠“猜最新一页”建立 baseline。对于“非终态 turn 一定位于最新页”的行为，应做目标机协议行为测试；它属于 baseline 优化前提，不应只根据当前样本推断。

全局 `bootstrap_initial_pass_completed_at` 的含义是：冻结的初始集合中，每个 thread 都已经完成至少一次 baseline 尝试，结果为 `monitoring` 或 `deferred`。达到这个条件后：

- 没有 deferred thread：`notifications=ready`；
- 仍有 deferred thread：`notifications=degraded`，这些 thread 后台继续重试；
- 在完成初始集合第一次尝试前：`notifications=initializing`。

因此单个永久不可读 thread 不会阻塞其他会话，也不会让系统永远停在 initializing。

baseline 后首次发现且**不属于冻结初始集合**的外部 thread 采用同一时间规则，不留“实现时再决定”的空白。首次看到该 thread 时先持久化 `first_discovered_at`，并把 `monitor_from_at` 固定为已有的 `bootstrap_started_at`；后续重启或 reconciliation 继续沿用这两个时间，不能把同一个 ambiguous thread 每次都重新视为“首次发现”。

它和初始集合 thread 一样，通知时间边界固定使用持久化的 `bootstrap_started_at`，**不能使用 `bootstrap_initial_pass_completed_at`**。后者只表示初始化进度，不参与任何 terminal suppression，而且在初始化未完成时本来就可能为 null。

- 如果存在 running turn，立即进入 `monitoring`，不得 suppression；
- terminal turn 的 `completedAt` 明确早于 `bootstrap_started_at` 所在秒时，作为初始化前历史 suppress；
- terminal turn 的 `completedAt` 等于或晚于该边界秒时，按新事件处理并允许通知；
- `completedAt` 缺失时：冻结初始集合首次 baseline 的未知 terminal 按历史 suppress；冻结后新发现 thread、此前已经观察到 running 的 turn，以及 Sea-Bridge 自己创建并已写 monitoring marker 的 thread 采用“不漏优先”，按新事件处理并记录 `bootstrap_boundary_ambiguous` warn。

对这种后发现 thread，需要从最新向旧读取，直到已经覆盖所有 `completedAt >= bootstrap_started_at` 的 turn；若达到页数/时间上限仍无法闭合边界，则保持 deferred/reconciliation，不得把当前页直接 baseline 掉。

Sea-Bridge 自己在初始化期间通过新建功能创建的 thread，在 `thread/start` 成功回调时就写入 `monitor_from_at=Date.now()` 并设置 monitoring 意图。因为当前 `registerCreatedThread(threadId)` 回调早于 `turn/start` 返回，这个 thread-level marker 足以防止首轮 turn 被 baseline suppression 吃掉；该方法的新实现必须改写 `desktop_observer_state`，不能再向 legacy `desktop_observer_cursors` 插入 `sea-bridge-created-pending-v1`。后续实际 turnId 被 observer 看到后再写 observation，无需为了这一点增加第二套回调协议。

### 14.4 停机升级步骤

推荐：

```text
1. 确认没有重要 Codex turn 正在执行
2. 停止 SEA-BRIDGE
3. 可选：备份 SEA-BRIDGE 自己的 sqlite 文件，便于人工回滚
4. 部署新版本
5. 初始化新的 `desktop_observer_meta/state` 与 `desktop_turn_observations`；旧 cursor 只停用、不双读
6. 启动 SEA-BRIDGE
7. ReadService capability probe
8. catalog 全量读取并冻结 bootstrap 初始集合
9. 各 thread 独立 baseline；状态最终为 READY 或 DEGRADED
```

不需要停止 Codex Desktop，也不修改 Codex 原生数据库/WAL。

如果新版本启动失败，直接修复/回退程序版本；需要时恢复 SEA-BRIDGE 自己的 DB 备份。由于本方案不要求无缝回滚，避免为回滚设计双 producer/双 schema。

停止服务必须等待在途 observer、outbox sender 和数据库连接退出，并确认没有第二个 SEA-BRIDGE 实例写入，再执行初始化。备份采用 SQLite 一致性备份，或确认所有连接关闭、WAL 已正确处理后的离线备份；不能在 WAL 含未 checkpoint 数据时只复制主文件。

因为本方案保留但停用 legacy `desktop_observer_cursors`，旧程序在 schema 层面通常仍能启动，但它看到的是升级前停下来的旧 ordinal cursor。若新版本运行期间已经处理/发送过新的 terminal，直接回退旧可执行文件可能从旧 cursor 重放这些事件；恢复升级前 DB 备份也可能重放 pending outbox、丢失新版本期间新增的 reply link 或其他本地状态。

因此回滚边界明确为：**允许人工回滚，但不承诺通知无重复或本地状态无损。** 回滚前优先修复新版本；确需回滚时根据是否已经产生新通知决定使用当前 DB 还是配套备份，并人工接受/核对重复风险，不为此重新引入双 schema。

## 15. Telegram 投递语义

本地 outbox 能保证同一个业务事件只生成一次待发送记录；Telegram API 与本地 SQLite 无法组成分布式事务，所以外部发送仍是 **at-least-once**。

存在极小窗口：Telegram 已发送成功，但 SEA-BRIDGE 在 `completeNotification()` 前崩溃，重启可能重发。自用场景接受这一点，优先保证不漏通知。

outbox sender 独立于 Codex catalog/history poll 和 baseline 运行，服务启动后即可重试保留的 pending 通知；Codex 读取失败或初始化未完成不能阻塞它。当前 `DesktopObserver.pollOnce()` 在读取成功后才调用投递，新实现必须拆开这项调度。sender 仍保持单实例投递、冻结正文和原有退避，不在 schema 初始化事务中进行 Telegram 网络调用。

迁移必须保持当前通知产品契约：

- final reply 在入队前继续经过现有 `redact()` 脱敏；当前标题没有走 `redact()`，只保留现有安全长度截断，不在本次迁移中悄悄改变标题语义；
- 整条 Telegram 文本继续受安全长度上限约束，超长标题/正文按现有语义截断，不能因为改用 items API 绕过限制；
- terminal 通知继续带“💬 回复”按钮，发送成功后由 `completeNotification()` 原子写入 `desktop_message_links`，保证 reply router 能定位 thread/turn；
- 某条 Telegram 发送失败只更新该 outbox 的退避，不阻塞其他 due notification；
- `telegramSummaryMaxChars` 等现有配置继续生效。

## 16. Action Session 保持独立

现有短生命周期链路继续保留：

```text
app-server
→ thread/start
→ turn/start
→ 等 turn/completed
→ thread/unsubscribe
→ 关闭进程
```

ReadService 与 ActionService 可以共享 framing 代码，不能共享审批 handler 或执行 ownership。现有 `CodexWebSource` 目前把 `listProjects/listModels/startThreadAndTurn` 放在同一个 `appServer` 依赖里，实施时必须拆成读取依赖和动作依赖：项目/模型/catalog 查询走 `CodexReadService`，`startThreadAndTurn` 只走 `CodexActionService`。`NewThreadManager` 也要按同样方式拆分 catalog provider 与 action executor，不能只改 WebSource 而让 Telegram `/new` 继续依赖旧的万能 client。

Action 校验按动作类型处理：需要当前 catalog/ownership 事实的动作不使用 stale LKG；Telegram durable link 回复可由 queue CLI 做最终接纳判定，不因为 ReadService 暂时不可用而预先拒绝；Web 客户端提供的 threadId 必须先经过同环境 CatalogStore/LKG 或 ReadService 的服务端 target 校验。所有动作自身仍返回实际接纳/失败结果，避免“先查后做”的 TOCTOU 被误当成最终保证。

## 17. 状态与日志

状态至少拆分：

```text
catalog: ready | stale | unavailable | protocol_incompatible
history: initializing | ready | degraded | stale | unavailable | reinitialize_required
notifications: initializing | ready | degraded | unavailable | reinitialize_required
projects: ready | unavailable
models: ready | unavailable
actions: ready | unavailable
```

`notifications=initializing` 仅持续到冻结初始集合完成第一轮 baseline 尝试；存在 deferred thread 时转为 `degraded`，不能被单个坏 thread 永久卡住。`history=degraded` 表示部分 thread baseline/reconciliation 失败，但其他已监控 thread 正常。

状态服务不能继续只用“`sessions()` 是否抛异常”推导 Codex 总状态，因为 `sessions()` 可能成功返回 stale LKG。catalog store/ReadService 必须显式暴露 freshness 与 protocol 状态；Web 可以继续展示 stale 会话，同时状态栏明确显示数据时间和 degraded/stale。

成功状态可较长缓存；stale/unavailable/protocol_incompatible 使用 2～5 秒短 TTL；ReadService 恢复 READY、bootstrap/deferred 状态变化时主动失效失败缓存。用户手动刷新应绕过失败缓存。

重复错误使用首条 warn + 聚合计数 + recovery info。记录 generation、CLI path/version、error 分类、restart/backoff、queue saturation、reconciliation generation、deferred thread 数与最老 overdue 时间；不记录 prompt、assistant 正文和附件内容。

## 18. 明确不采用的方案

- 只增加 SQLite 重试；
- `readwrite + query_only` WAL 回退；
- 永久直接读 `state_5.sqlite` / `thread_history_1.sqlite`；
- SQLite compatibility fallback；
- V2/legacy 双表；
- 双读/双写；
- shadow observer + 双 producer cutover；
- owner epoch/fencing 迁移机制；
- 旧 ordinal → turnId 的完整数据迁移；
- 用 `recencyAt` 当唯一事件版本；
- 把分页 cursor 当持久增量游标；
- LKG 替代动作实时确认；
- Telegram exactly-once；
- 手工修改生产 Codex WAL/SHM。

## 19. 自动化测试要求

至少覆盖：

1. 实际 CLI path/version/schema fingerprint 绑定；
2. ReadService capability probe 成功后才 READY；
3. 查询 API/运行时白名单；
4. ReadService 拒绝 Action inbound 请求；
5. 子进程 crash/backoff/recovery；
6. 单次 RPC 业务错误不错误重启；
7. 旧 generation 迟到结果不污染新状态；
8. shutdown 后不再重启；
9. 并发/queue/message-size 上限；
10. thread/list 多页完整提交；
11. 中间页失败保留旧 LKG；
12. cursor 循环检测；
13. 重复 threadId 去重；
14. 热页 merge 不删除冷会话；
15. thread 消失需再次完整扫描确认；
16. stale LKG 不能伪装成实时动作确认；Telegram durable link 回复可由 queue CLI 最终判定，Web send 则必须先由同环境 CatalogStore/LKG 或 ReadService 做服务端 target 校验；
17. null recency 仍周期补查；
18. running thread 滑出热页仍持续跟踪；
19. 冷 thread 5 分钟上限补查；
20. anchor + overlap；
21. anchor 找不到不推进；
22. 分页失败不推进 anchor；
23. running→terminal；
24. terminal 先出现、final reply 后出现；
25. pending-content deadline 跨重启保持；
26. finalText 变化不生成第二条 terminal 事件；
27. terminalKind 冲突进入异常路径；
28. observation/outbox/anchor 本地事务故障注入不丢通知；
29. 新 observer schema 初始化不修改 DSH/账号/其他状态；
30. 旧 `desktop_observer_cursors` 运行时彻底停用且不会再被写入；旧行可保留到后续清理，不尝试 ordinal 数据迁移；
31. 旧 `desktop_message_links` 保留，升级后旧 Telegram 回复仍可找到 thread；
32. 旧 pending `desktop_notification_outbox` 升级后继续投递；
33. baseline 已 terminal 历史不补发；
34. baseline 时 running turn 之后 terminal 正常通知；
35. 旧 links/outbox 中已有 turn 不重复生成；
36. baseline 失败不会标记完成或产生历史洪峰；
37. baseline 期间 Sea-Bridge 新建 turn 不被 suppression；
38. Telegram send 成功后本地 crash 的 at-least-once 语义；
39. CODEX_HOME 在 ReadService、ActionService、ProcessCodexQueueClient 三条 CLI 路径上显式绑定且一致，并验证测试 spawner/runner 实际收到 child env，而不是只验证 options 字段；
40. 状态短 TTL 与恢复主动失效；
41. 重复日志限流。

再次审查补充：

42. `schema_initialized_at` 与新表创建原子提交，且不会被误当成 baseline 完成；普通重启和 CLI 升级不重复清空状态；
43. schema 已初始化但 baseline 未完成时继续处理，失败 thread 不重置已完成 thread；
44. 首次观察的 running turn 在全局初始化未完成时仍可产生 terminal 通知；
45. bootstrap 后创建并在下一次目录轮询前完成的 turn 不被历史 suppression；
46. 旧 started/reply_prompt 等非终态 link 不抑制 terminal，去重使用 threadId+turnId；
47. 保留旧 outbox fingerprint，事务检查旧 terminal 身份，不新增重复 outbox；
48. Codex 不可用及 baseline 失败期间旧 pending outbox 仍投递；
49. 定向 reset 保留所有非目标表，第二次执行不清空新监听状态；
50. 停机备份/恢复的 WAL 一致性与旧程序 schema 兼容边界；
51. app-server 异步 RPC 不通过同步 `CodexThreadReader` 伪装调用，本地 catalog snapshot 与当前事实查询边界正确；
52. ReadService 不可用时，Telegram durable link 回复仍可尝试投递；Web send 只有在同环境服务端 CatalogStore/LKG 已知该 threadId 时才可尝试，二者均以 queue receipt/退出状态作为最终结果；
53. baseline 最新页优化只有在目标 CLI 验证非终态 turn 一定位于最新页时启用，否则继续分页查找；
54. 首次发现 thread 的 `first_discovered_at` 跨重启保持，ambiguous 边界不会反复重新分类；
55. `NewThreadManager`/Telegram `/new` 与 WebSource 都完成 ReadService/ActionService 依赖拆分；
56. allowed chat 配置变化不会让历史 terminal turn 被重新生成；旧 pending outbox 仍按自身保存的 chatId 投递；
57. 第 13.5 与 14.2 节的 terminal 去重均跨历史 chat，仅按 `(threadId,turnId)` + terminal 类型判断；
58. 初始集合与后发现 thread 的 terminal suppression 都统一使用 `bootstrap_started_at`；`bootstrap_initial_pass_completed_at` 只表示进度，不参与事件分类；
59. baseline 需要多页时，所有已读取页中的非终态 turn 都进入 monitoring，不只第一页；
60. `desktop_observer_meta.codex_home_identity` 与当前 CODEX_HOME 不一致时进入 `reinitialize_required`，不复用 anchor/observation、不自动清空，且 Codex create/open/queue 在完成显式环境切换前不可用；
61. `bootstrap_started_at` 在首次 catalog 扫描前一次性持久化；catalog 首扫失败重试不会后移该边界；扫描期间完成且 `completedAt >= bootstrap_started_at` 的 terminal 即使后来进入冻结初始集合也不会被 suppress；
62. `monitor_from_at` 对 observer state 为必填；恢复/reconciliation 不得 fallback 到较晚的 `monitoring_started_at`，缺失时进入 deferred/error；
63. 新 observer final reply 继续执行现有脱敏，标题继续执行长度限制，整条 Telegram 总长度、摘要截断和“💬 回复”按钮契约保持不变；
64. `completeNotification()` 仍原子完成 outbox sent + message link，单条 Telegram 失败不会阻塞其他 due notification；
65. stale LKG 只提供 catalog metadata，不能沿用旧 `running/idle/waiting`；有当前 activity/approval/ownership 证据时重新计算，否则 WebSession.state=`unknown`；
66. 真正切换 CODEX_HOME 时要求旧 Codex pending outbox 先排空，并使旧 `desktop_message_links` 失效；DSH/账号等其他状态不受影响；
67. app-server catalog 与当前 `CodexThreadStore` 的未归档/subagent 过滤、标题 fallback、Desktop/CLI/Sea-Bridge/Exec/unknown 创建来源语义保持一致；
68. 冻结初始集合首次 baseline 中，`completedAt=null` 且此前从未观察过的 terminal 必须 suppress；
69. 同一 turn 如果先观察到 running，随后 terminal 且 `completedAt=null`，必须正常通知；
70. Sea-Bridge created marker 下的首个 terminal 即使 `completedAt=null` 也不能被 baseline suppress；
71. 一个 stdout chunk 内多条完整 JSON 即使总长度超过未完成 buffer 上限，也必须逐行正常消费；
72. 单条合法 JSON 超过旧 1 MiB 但低于当前有界上限时可正常解析；真正未换行的超限 buffer 和超过单条消息上限仍必须 fail-closed；
73. 正在执行的 turn 被独立 ReadService 暂时读成 `interrupted`，且无 `completedAt/final_answer` 时保持 pending，不入 outbox；
74. 上述 provisional interrupted 即使超过普通 settle deadline 也不能自动通知，后续变 `completed` 后必须正常发送真正完成正文；
75. 同 turn 的近期 exact `Interrupt` Hook 可以确认无时间戳 interrupted；官方带 `completedAt` 的 interrupted 也可直接确认；
76. 已发送的旧 interrupted terminal 后续被官方明确 completed + 完成证据纠正时，只生成一次 completed correction，旧 reply link 保留；
77. 旧 interrupted 仍在 pending outbox 时，completed correction 原子删除旧 pending interruption 并用独立 correction fingerprint 入队。

## 20. 目标机验收

1. 记录实际 CLI path/version/schema；
2. 验证 thread/list 完整分页、thread/turns/list 多页和 thread/items/list 所需字段；
3. 停止 SEA-BRIDGE 后升级，确认 DSH/账号/Telegram 历史 link 不受影响；
4. 首次 baseline 不产生历史通知洪峰；
5. baseline 时存在 running turn，之后完成能正常通知；
6. 548+ thread catalog 完整；
7. ReadService crash/restart 后 LKG stale 展示并恢复；
8. 同秒变化、null recency、final reply 延迟均不漏掉监控期 terminal；独立读取暂时返回的无证据 interrupted 不得提前通知，并在真实 completed 到来后发送完成结果；
9. 发送消息、新建会话、Desktop ownership 无回归；
10. 长时间运行无 app-server/pending request 泄漏或重启循环；
11. 真实大历史查询不再触发 `app_server_stdout_buffer_limit`，并确认分页请求使用较小批次；
12. 首次 baseline 抽查 `completedAt=null` 的旧 terminal 不入 outbox，同时 running→terminal(null timestamp) 仍正常通知；
11. 升级 Codex 后重新跑协议兼容测试。

12. Codex 读取不可用时，升级前 pending outbox 仍继续重试；
13. 连续重启不重复 baseline、不丢已追踪 pending turn；
14. 非终态历史 link 不阻止完成通知；目录轮询间新建且完成的会话正常通知；
15. 切换 CODEX_HOME 后 Codex observer 与动作明确进入 `reinitialize_required`；旧 pending outbox 排空、旧 Codex reply link 失效并执行定向重新初始化后恢复；
16. 首次 catalog 扫描失败并重试时 `bootstrap_started_at` 保持不变；扫描期间新建并完成的 thread 无论后来是否进入冻结初始集合，都按该固定边界分类，不被误 suppress；
17. baseline 多页场景中较旧的 running turn 也会被持续跟踪到 terminal；
18. 新 observer 的通知文本脱敏、长度限制、回复按钮、reply link 和单条失败隔离与当前行为一致；
19. ReadService 不可用时使用 stale LKG 展示会话，但不会继续显示缓存的旧 running/waiting 状态；
20. catalog 迁移后创建来源筛选/标签、标题 fallback、归档和 subagent 过滤与当前页面一致；
21. 在 Desktop/CLI 另一进程真实执行一个耗时 turn，确认 ReadService 即使中途投影 `interrupted` 也不会发中断通知，最终只收到 completed/final reply；另做一次真实用户中断，确认 exact Interrupt Hook 或官方 completedAt 能形成中断通知。

WAL/SHM 实验只能在隔离 CODEX_HOME 或测试数据库执行，禁止修改生产 Codex 的 sidecar。

## 21. 最终实施顺序

1. **冻结协议边界**：实际 CLI path/version/schema/CODEX_HOME，并统一 ReadService、ActionService、queue CLI 的环境注入方式。
2. **实现 `CodexReadService`**：查询 API、白名单、supervisor、generation、资源上限。
3. **实现 catalog + LKG**：完整分页提交、热页 merge、stale 降级；引入本地 `CodexCatalogStore`，逐步替换同步 `CodexThreadReader` 调用点，然后停止使用 `CodexThreadStore`。
4. **实现新的单套 observer 状态模型**：`desktop_turn_observations`、新 anchor cursor 语义；继续复用现有 outbox/link。
5. **实现一次性 observer reinitialize**：废弃旧 ordinal cursor，baseline 当前官方历史；不做旧新双读双写。
6. **切换 Telegram observer 到 `thread/turns/list` / `thread/items/list`**，删除 `ThreadHistoryStore` 运行时依赖。
7. **正确性验证后启用热集优化**；recency 只负责调度。
8. **目标机停机升级并验收**。
9. 后续如有需要，再单独设计 Web history/附件/queue diagnostics 的 rollout 迁移。

修订记录（2026-10-05）：根据“单人自用、允许停机升级、不要求无缝兼容”的实际约束，删除 V2、双读双写、shadow/cutover、owner fencing、SQLite fallback 和旧 ordinal 数据迁移；改为 Codex observer 定向重新初始化，保留现有 Telegram link/outbox 与 DSH/其他 SEA-BRIDGE 状态。

规格阶段记录：本文已完成诊断与简化后的最终实施规格；当时尚未修改生产代码。实际代码实施结果见文末“实施记录（2026-10-05）”。Codex 原生数据库始终未被修改。

修订记录（2026-10-05，再次审查简化方案）：认可定向重新初始化及升级窗口通知缺口；直接补充一次性 reset 的原子标记、逐 thread baseline 续做、terminal-only 旧记录去重、独立 outbox sender 和一致性备份/回滚边界。没有重新引入双 observer、fencing 或旧 ordinal 数据迁移。

修订记录（2026-10-05，全面实现前审查）：再次对照 `main.ts`、`DesktopObserver`、`DesktopMessageStore`、`CodexWebSource`、`ProcessCodexQueueClient`、`CodexAppServerClient`、`NewThreadManager`、状态服务及现有 observer 测试完成全链路核对。统一跨 chat terminal 去重和 `bootstrap_started_at` 时间边界；多页 baseline 处理全部非终态 turn；observer 状态绑定 CODEX_HOME 并 fail-closed；明确 child process env 注入、异步 ReadService/本地 CatalogStore 边界、Web send 服务端 target 校验、stale LKG 运行态降级、现有 Telegram 通知契约及创建来源语义。自动化测试要求现为 67 项。

实施记录（2026-10-05）：已按本规格完成生产代码实现。新增长期 `CodexReadService`、Sea-Bridge 自有 `CodexCatalogStore`/LKG、持久化 observer meta/state/turn observation，以及 `codex:observer-reset` 维护命令；`main.ts` 的 Codex catalog/terminal observer 已不再运行时构造 `CodexThreadStore` 或 `ThreadHistoryStore`。ReadService/ActionService/queue CLI 显式共享同一 `CODEX_HOME`；终态去重、outbox、anchor 在本地事务边界内提交；outbox sender 与 Codex 读取解耦；状态页区分 stale、protocol incompatible 和 reinitialize required。Web 历史/附件仍按第 12 节保留 rollout JSONL，`queue_1.sqlite` 也仍作为独立诊断/队列来源。

实现后追加审查还修复了：异常协议 shape/cursor fail-closed、单次 timeout 不杀进程而连续 timeout 才重连、旧 generation 结果隔离、主动关闭立即拒绝 pending RPC、延迟 final answer settle、首次 baseline 多页中的旧 running turn、thread 从 active catalog 消失后的持续 reconciliation、同一 CODEX_HOME 重置保留 pending outbox，以及真正切换 CODEX_HOME 时清理旧 Codex 临时交互状态。随后验收又修复：明确排除 `commentary` 作为 final reply，并为全 phase-less 旧协议定义保守 fallback；observer 调度改为 urgent/cold/hot 公平配额；`CodexObserverStore` 移除全部类型绕过；legacy fallback 先判定 phase 字段存在性。第一次真实部署又暴露并修复两项：冻结初始集合首次 baseline 对 `completedAt=null` 的未知历史 terminal 采用 snapshot suppression，避免历史通知洪泛；app-server stdout framing 改为逐行消费并将历史分页默认大小降为 25，单条/未完成消息仍受有界可配置限制。部署后真实任务又暴露 `interrupted` 投影并非可靠终态：独立 ReadService 在另一个进程仍执行 turn 时可短暂返回 `interrupted`。现已把“无 completedAt、无 final_answer、无 exact Interrupt Hook”的 interrupted 改为 provisional pending；真正 completed 可以覆盖该 provisional 状态。对已经由旧代码发送的错误 interrupted，只有官方后续 completed 且具备完成证据时允许一次窄范围 correction，并使用独立 fingerprint。当前验证为 `bun run typecheck`、`node --check src/web/public/app.js`、`bun run build`、`git diff --check` 全部通过，`bun test` **409 项全部通过、1841 个断言通过**。目标机 Codex 0.160.0 主读取 RPC 已由真实验收验证；本轮 interrupted 修复尚未重新部署，仍需按第 20 节做真实长 turn/真实中断验收。**未执行 observer reset、未重新部署、未 commit/push。**

### 2026-10-06 部署前补充审查

- 尚未完成 completed correction 的已通知 interrupted 记录必须纳入 `pendingTurnIds`，让 anchor + overlap 分页持续扫描到该 turn；否则 anchor 越过两条后可能永久漏掉旧误报更正。baseline_suppressed 的历史中断不纳入此追踪。
- correction 成功将 terminal kind 更新为 completed 后退出额外追踪；回归验证先复现 interrupted 入队后待扫描集合为空，再验证修复后保留、完成更正后移除。
- 生产数据库一致性副本 + Codex 0.160.0 只读验收生成 7 条带正文的 completed correction；没有调用 Telegram 发送或修改生产数据库。
