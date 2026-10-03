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
