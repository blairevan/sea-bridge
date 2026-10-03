# Codex 队列后台执行诊断

日期：2026-10-03。状态：投递和后台执行验证通过；原来的单次长时间排队故障尚未复现，根因和修复未确认。

## 职责边界

Sea-Bridge 使用嵌入 Codex CLI 的 `queue` 命令投递。执行、锁、队列消费和调度由 Codex 负责。没有证据支持在 Sea-Bridge 中增加队列启动器、解除锁或修改原生数据库。

## 原故障时间线

- 09:39:51：上一轮任务完成。
- 09:44:10：网页消息投递返回成功；用户截图显示原生队列消息。
- 09:58:46：下一轮任务开始，等待约 14 分 36 秒；用户描述此时将 Codex 切回前台。
- 用户确认应用一直运行，只是切到了其他窗口。
- 本机电源日志该时间段没有找到 Sleep/Wake 记录，存在 Electron 防止系统空闲休眠断言。这不能证明应用自身没有被限制。
- Desktop 主日志没有记录足以还原该会话队列消费决策的事件。原生 logs_2.sqlite 在检查时为空。

## 对照验证

使用用户明确授权的临时 projectless 会话，只发送要求回复 OK 的诊断消息，不调用业务工具或修改业务文件。独立观察器只读原生队列和 rollout，不请求 Desktop 会话状态，不触发启动。

| 条件 | 入队时间 | 原生任务开始 | 完成 | 入队到启动 |
| --- | --- | --- | --- | --- |
| Desktop 已切到后台 | 10:27:49.600 | 10:27:54.012 | 10:27:57.191 | 4.412 秒 |
| 本轮诊断结束后空闲 60 秒 | 10:32:05.122 | 10:32:14.018 | 10:32:15.024 | 8.896 秒 |
| 再空闲 180 秒 | 10:35:15.299 | 10:35:24.028 | 10:35:26.196 | 8.729 秒 |

三次均由 Codex 自身启动，无 Sea-Bridge 调度。临时会话曾通过 Codex 原生工具确认归档；追加长空闲测试时已恢复该测试会话，待测试结束后再次清理。

使用独立临时 CODEX_HOME 和仅运行在 loopback 的模拟 Responses 服务，还确认：完整初始任务结束后，原生 app-server 能发现另一个 CLI 进程写入的队列，并自动开始下一轮。取消客户端订阅后可能不再向该客户端发送队列通知，但这不能推出后端不会执行：实验也观察到后端状态变化。不要混淆客户端通知和服务端调度。

## 结论与限制

- 已验证现有 CLI 投递路径和 Codex 自动消费机制正常配合，后台及短期空闲并不必然卡住。
- 未发现 Sea-Bridge 获取或持有 Codex 任务发送锁；投递实现仅执行 queue 子命令。
- 原故障可能属于特定会话状态、运行时瞬态或更长空闲条件。当前不能在这些可能性之间作出证据支持的选择。
- 不将“没有显式 queue/start 调用”当作缺陷：正常情况下 Codex 会自动消费，额外调度可能造成职责重复。
- 本次尚未完成故障修复，生产版本仍为 v0.6.0。

## 后续取证

- [ ] 在更长后台空闲条件下复现，且观察进程不得唤醒 Desktop。
- [ ] 卡住时同时保留队列 ID/入队时间、原生会话加载/暂停状态、后端 PID 和队列消费日志。
- [ ] 对比切回前台前后的状态，确认触发恢复的具体事件，再选择修复位置。

## 已执行命令

```sh
python3 /tmp/sea-bridge-queue-lifecycle.py
python3 /tmp/sea-bridge-live-queue-probe.py
python3 -m py_compile /tmp/sea-bridge-background-queue-diagnostic/probe.py
python3 /tmp/sea-bridge-background-queue-diagnostic/probe.py
```

后台诊断的完整生命周期元数据位于 `/tmp/sea-bridge-background-queue-diagnostic/result.json`。临时文件可能随系统清理而消失；上表保留已验证结果。CLI archive 测试返回非零，随后使用 Codex 原生归档工具完成清理，未将 CLI 尝试视为已完成。

## 追加长空闲测试

已启动独立观察进程，等待本轮任务完成后空闲 600 秒，再投递一条诊断消息并观察 120 秒。结果文件为 `/tmp/sea-bridge-background-queue-diagnostic/long-idle/result.json`。状态待完成。若测试期间有新的 Desktop 任务运行或用户切回应用，该轮不能证明连续后台空闲条件，需要结合时间线判断。

```sh
python3 -m py_compile /tmp/sea-bridge-background-queue-diagnostic/long-idle/probe.py
python3 /tmp/sea-bridge-background-queue-diagnostic/long-idle/probe.py
git diff --check
```

## 长空闲测试进程修正

后续检查发现首次 600 秒测试停留在 idle_delay，进程已不存在，原生队列及 rollout 均没有该次测试投递记录。因此它不是通过或失败的 Codex 测试结果。已改用 macOS launchctl 托管一次性观察进程，RunAtLoad=true、KeepAlive=false；确认已分配 PID，状态为运行，等待当前诊断任务完成。该临时任务不调用 queue/start，不修改原生数据库，不控制 Desktop 界面。

```sh
launchctl bootstrap gui/501 /tmp/sea-bridge-background-queue-diagnostic/long-idle/launch-agent.plist
launchctl print gui/501/com.aitools.sea-bridge.queue-diagnostic.temp
```

测试完成后还需读取结果、再次归档临时测试会话，并移除该临时 launchctl job。生产 Sea-Bridge LaunchAgent 未改变。

## 最终状态（17:37 后更新）

长空闲托管测试已完成：17:21:42投递返回成功，120秒内未观察到新任务；17:37仍保留在原生队列。v0.6.1日志确认最近任务idle、无待审批、rollout没有后端打开句柄。此会话曾归档/恢复，因此该现场不能直接证明原故障根因。诊断日志已部署，具体证据和读取限制见 [日志记录](2026-10-03-queue-diagnostics.md)。临时会话已再次归档，托管测试job已卸载。以上更新替代先前“测试待完成”和“生产版本v0.6.0”的当前状态描述，先前记录保留作时间线。

## 18:09 / 18:10 真实业务现场

用户提供两张手机截图：网页18:09显示两条排队，Desktop18:10显示第一条已运行4秒、第二条仍排队。两图时间不同，不能直接定性网页排队标记错误。新诊断日志精确关联原生client_id证明：

- 网页17:55:49.866提交，17:55:50.024返回成功，queueItemId=01a10130-fc2f-71a0-9eb7-54af53f4d0c9；原生18:10:38.449开始，等待约14分49秒。
- Telegram18:00:39提交，queueItemId=01a10135-67e7-7521-aab3-bccd95141c32；原生18:10:55.543开始，等待约10分16秒。
- 两条输入分别精确关联到turn 01a1013e-8ae6-71e2-87d4-9100ad963c42、01a1013e-cdb2-7ef3-97a9-b5fffbc0184f。18:10:48和18:10:58的观察轮询记录队列移出。
- 17:57、18:02、18:07的等待快照：latestState=idle，前一任务17:54:45.904完成，无pendingApproval、hook=null，Codex进程存在，rolloutOpenPids为空。不存在“前一轮还在执行，因此正常排队”的证据。句柄为空仅支持调查会话加载状态，不能证明锁、暂停或具体后台策略。
- 网页标题“状态未知”的确定原因是sessions()只使用Hook/owner状态，没有使用已有rollout生命周期兜底；它是状态发现的缺口，与真实长等待分别分析。
- “当前会话无待处理”的先前答复来自18:11执行期间/之后的队列检查，不能否定18:09仍在排队。

现场确认长等待再次出现，原生内部消费决策仍未观测。不得通过Sea-Bridge代替原生调度或篡改原生队列来掩盖问题。

## 未加载会话消费机制隔离验证

本机当前嵌入CLI（实时验证0.160.0）、独立临时CODEX_HOME、仅loopback模拟Responses，无用户凭证或业务提示词。先完成测试任务，再关闭隔离后端，启动新隔离后端，保持该会话未加载。CLI queue返回0；等12秒后原生队列仍有1项，thread/loaded/list为空。调用同一隔离后端的thread/resume后，再等12秒队列为0，收到turn/started，loaded列表包含测试会话。不调用turn/start消费排队输入，不重发，不修改生产队列。

命令：`python3 /tmp/sea-bridge-unloaded-queue-probe.py`。结果：`/tmp/sea-bridge-unloaded-queue-result.log`。该实验确认“未加载+成功离线入队不会自动开始；恢复加载后原生消费”的机制，真实Desktop现场的loaded状态没有直接读取，不能把吻合迹象当成完整内部根因证据。

运行Desktop直属app-server PID66038默认stdio，无unix/ws监听，lsof无命名unix控制socket。`codex app-server daemon version`报告本机app-server-control.sock不存在。正式proxy支持--sock，但没有可供其连接的Desktop socket。Sea-Bridge自己的app-server不是Desktop同一后端，不能将对它的thread/resume当成安全Desktop唤醒。

修复边界：原生队列入队应唤醒对应执行后端并加载会话，或Desktop提供稳定的同后端RPC连接方式；当前没有验证可用的生产自动唤醒入口，因此没有启用兼容唤醒。v0.6.4仅修正原生状态显示和长等待识别。

版本边界：先前调查记录曾为0.159.2，当前`codex --version`为0.160.0；本轮隔离实验使用当前0.160.0。不能通过磁盘上CLI版本直接证明早先启动的Desktop后端进程版本相同。

## 共享后端接入验证与待批准切换方案

本节更新前文“无可用入口”的调查结论：当前安装包只读检查发现入口存在于 `.vite/build/application-network-startup-ouXbhtc5.js`，先前缓存main文件不足以覆盖拆分模块。

- `CODEX_APP_SERVER_USE_LOCAL_DAEMON=1` 分支要求配置覆盖项为空；Desktop自动生成app-tools等覆盖项，不能仅设置此变量就保证共享后端生效。公开报告 https://github.com/openai/codex/issues/41014 描述相同限制，属于用户报告，不能当作官方修复承诺。
- `CODEX_APP_SERVER_WS_URL` 显式连接入口在当前包中存在，优先选择WebSocket transport，绕过私有stdio的启动分支。包内WebSocket实现支持 `ws+unix:`。入口仍属未公开稳定接口。
- 工具覆盖项只在stdio启动分支生成，因此真实Desktop的app-tools、密钥存储覆盖、审批、历史和通知必须验收，不能承诺原功能完整保留。Unix URL应使用localhost主机部分，避免Desktop将空hostname误判为外部地址而选择SOCKS代理。

隔离验证命令：`python3 /tmp/sea-bridge-shared-websocket-probe.py`。测试使用临时CODEX_HOME、loopback模拟模型、现有Python websockets库；没有安装依赖、生产环境变更、真实提示词或用户凭证。一个原生后端监听私有Unix socket，两个独立RPC客户端连接，输出 `shared_loaded True`、`remote_queue_exit 0`、`remaining 0`、`second_client_resume True`。证明相同后端的多客户端观察、远程投递及恢复可工作；尚未验证真实Desktop。先前proxy对手动监听socket的探测initialize超时，不作为成功路径。

待批准方案：
1. 在当前任务结束后备份Codex配置、队列与Sea-Bridge服务配置；确认无任务运行，再完整退出Desktop。
2. 用现有完整捆绑CLI启动单个共享原生app-server，socket仅本机用户访问；Desktop显式连接它，Sea-Bridge通过同一socket投递和恢复会话。完整包直接复用，不新增npm/Python依赖。不得同时保留两个占用同一业务会话的后端。
3. Sea-Bridge成功投递后检查同一后端loaded状态，仅对未加载的目标会话执行thread/resume；不重发输入、不调用turn/start、不自行推进下一条，运行中的会话保持原生调度。投递成功但恢复失败分别记录；连接中断不能触发重发。
4. 为后端连接、恢复失败、重连与投递未知增加测试；验证后台空闲后投递、连续队列、Desktop审批、应用工具、历史和Telegram通知。无法保留关键Desktop功能即回滚，不能将日志改善标为自动唤醒修复。
5. 回滚时先停共享后端，清除本次Desktop连接覆盖并恢复原服务配置，重启Desktop；保留原生队列，禁止清空或重复提交。

该方案更改Desktop后端接入并要求完整重启，属于需要用户批准的架构切换。本轮仅完成只读包检查、隔离实验与方案记录；未修改生产Codex接入或部署自动恢复。

## 非侵入式打开会话验证

用户明确拒绝共享后端等侵入式修改，前述共享后端切换方案已放弃，不再作为待批准实施项。生产Desktop配置和接入方式没有修改。

用户授权临时测试，创建会话 `01a10206-f239-75d1-94cc-7b63265a7c12`，首轮仅回复OK。归档后恢复，以构造未加载状态；read_thread确认notLoaded。使用现有CLI投递单条测试输入，成功回执 `01a10207-739b-7082-bedc-3407b84b2a1b`。等待20秒后，read_thread仍为notLoaded、无新turn，原生队列只读计数为1。

调用Codex提供的navigate_to_codex_page打开临时会话，返回navigated=true。20秒后read_thread确认新turn `01a10208-22d7-79c3-aae4-02d3ba1426bb` 已完成，回复QUEUE-OPEN-OK，队列计数为0。原消息仅投递一次。测试完成后返回业务会话并归档临时会话。

验证边界：这是人为构造未加载状态的单次对照实验，验证原生导航可触发加载并消费已有队列。未通过macOS外部codex://链接调用，未验证窗口前台焦点变化，也未证明自然后台偶发现场全部属于此机制。Sea-Bridge手动恢复按钮尚未实现或部署。不得将本结果写成外部深链全链路验证通过。

验证使用：Codex create_thread、read_thread、navigate_to_codex_page、set_thread_archived工具；捆绑CLI `codex queue --thread <test-thread> --message <test-marker>`；Python sqlite3 mode=ro只读查询queued_items；`git diff --check`。
