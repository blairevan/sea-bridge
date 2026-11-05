# ToolHub → SeaBridge 持久任务会话

## 授权、范围和事实

用户已确认对话中的完整设计，并要求既有任务接续而非重复开发；沿用“改完就部署”的本机交付授权。本文将已确认设计落实为可测试接口，不宣称用户单独审阅过这个新文件。范围为 SeaBridge 与 ToolHub 的本机集成，不推送远端，不代用户验收或合并 tokscale 候选。

当前 SeaBridge 使用 Desktop 内置 Codex (`projectId` 可持久化)，与全局 CLI 的 schema 不同。实现复用 SeaBridge 的 AppServerSession、目录服务和会话观察器；禁止另起 ToolHub `exec --ephemeral` 作为降级路径。

## 协议与状态

新增私有 Unix socket `run/tasks.sock`（0700 父目录、0600 socket、同属主），不暴露在 7310 公共 HTTP，不借用浏览器 Cookie。新增服务自有表保存实例 ID、不可变 operationId、请求摘要、taskId/revision、projectId/repository/worktree、threadId/turnId、终态、报告和释放状态。重复 operationId 只返回原结果，内容不同返回冲突；一次任务最多一个未释放操作。

`POST /v1/turns` 在发送任何 Codex 请求前持久化，返回操作记录；`GET /v1/operations/:id` 查状态；`/interrupt` 只中断精确轮次；`/release` 只释放已经终止的写入者；`/guard` 为检查或合并重新持有同一会话，核验没有出现后续轮次。崩溃中的不确定投递进入 unknown，不隐式重发。前端只能经现有账号/CSRF 访问 ToolHub，不直接访问 socket。

所属 Codex 项目可以是父工作目录，真实仓库必须在其范围内；执行 worktree 必须位于配置的任务工作区根，Git common-dir 必须与仓库一致。历史路径和客户端自报路径不是授权。持久会话显式 `ephemeral=false`、原 projectId，轮次 cwd 为已验证 worktree；补充要求/返工复用同一个 threadId，可更换同仓库的任务 worktree，不能偷偷换项目。

任务专用权限不继承桌面 full-access 模式：固定 filesystem profile、无网络、Git 元数据只读、仅任务 worktree/私有 TMPDIR 可写。接续核验 mode=review 只读工作区。模型只修改和解释；监督器执行冻结检查、提交与验收后合并。执行结束必须核验精确 turn.status，并持有源 writer 至监督器封存；未知状态不得作为成功或释放执行槽。

## UI、迁移和一致性

ToolHub 展示 SeaBridge 关联、原生 thread/turn 标识、查看/打开入口及错误原因。SeaBridge 深链接定位实际会话。Web 续聊对已管理任务返回任务中心重跑请求，不并发写同一工作区；Desktop 外部新轮次必须使旧交付守卫失败，要求重新检查。

原 tokscale 任务保持当前待验收与提交 f960fb95；新增只读接续会话，明确说明此前由 CLI 完成、不是原生历史。不可重写先前日志或提交记录，不自动验收合并。

## 实施与自审清单

1. 临时 SQLite/真实临时 Git/假 App Server 覆盖持久去重、路径边界、终态和恢复。
2. SeaBridge 私有任务接口、持久驱动、共享会话目录接入与 UI 深链接。
3. ToolHub 去掉直接模型执行入口，关联记录、取消/续聊/交付守卫与兼容旧任务。
4. 两仓库全量测试、类型检查、构建、diff/凭据审查。
5. 本机备份账本与服务、无活动执行时切换；真实持久会话接续核验，不代签原任务。

自审：不存在把 accepted/idle 当作完成的路径；双边持久化可协调但不能宣称分布式 exactly-once；已送出但未知结果必须保守处理。服务接口仅提供固定动作而不是任意 shell。模型/用户继续会话后旧候选不可自动合并。实际 Desktop UI 可见性需独立核验，不能由 threadId 推断。

### 2026-11-05 原生协议联调补充

真实 Desktop 内置 Codex `0.166.0-alpha.6` 中，新建空会话的活动投影可能暂不含项目关联；先持久化创建并确认释放创建进程，再恢复同一个 thread（不是重复创建）发起首轮。活动投影的缺失字段通过独立只读原生查询核对，绝不直接写 Codex SQLite 或容忍不同项目。第一次 ToolHub 关联的空值、并发交付守卫与释放后的会话状态回落均有回归覆盖。

隔离原生演练已通过真实模型修改、commit、固定检查、测试操作员验收、实际合并及持久会话回读。它只使用隔离样例，不代表 tokscale 已获人工验收。证据及本机联合发布目录：`~/.toolhub/deployments/20261105-joint-v219-I5QmM9/`；部署、原业务会话接续和最终版本以当次回执为准。
