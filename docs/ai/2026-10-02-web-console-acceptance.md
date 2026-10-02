# Web 控制台验收记录

## 基线与工作区

- 日期：2026-10-02。
- 用户指定当前目录直接使用 `feature/web-console`，不使用 worktree；已归档刚创建且未修改的托管 worktree。
- 设计及计划基线提交：`b58a922`。
- Bun：1.4.2。初始 `bun test`：172 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- 仓库没有 lint/format 脚本；不新增依赖。
- 实际服务标签：`com.aitools.sea-bridge`；恢复/重启应使用该标签，部署前重新核对实际 plist 和程序入口。
- Tailscale：1.102.2。已有 TCP Serve：13080 → loopback 3080，必须保留；当前没有读取到 Funnel 配置。
- 拟用端口 7310：基线检查无监听。未启用 Web，未修改 Tailscale。

## Task 1：首轮解耦

- 客户端原样发送 prompt；Telegram manager 的直接和待输入创建路径保留历史前缀。
- 已观察前缀测试先失败；实现后聚焦 20 pass / 0 fail，全套 176 pass / 0 fail。
- owner 释放只在进程确认关闭后通知，覆盖完成、并发关闭、创建前失败和首轮失败。
- `bun run typecheck`、`bun run build`、`git diff --check` 通过。

## 未完成运行验收

- 本机配对、设备撤销、双浏览器全局脱敏：待实施。
- Codex/dsh 网页真实创建、发送和审批链路：待实施。
- Tailnet HTTPS Serve 配置、手机、第二台电脑：待实施，未宣称通过。

## Task 2：Web 配置与生命周期

- 独立 `loadWebConfig` 避免错误 Web 配置阻断 core 启动；默认关闭，7310 默认端口，精确 HTTPS origin 校验。
- 生命周期测试覆盖关闭模式无构造、部分启动清理、失败隔离与重复关闭。当前为不暴露任何路由的生命周期骨架。
- 聚焦 5 pass，全套 181 pass；`bun run typecheck`、`bun run build`、`git diff --check` 通过。

## Task 3：Web 独立持久化

- 新增事务迁移、设置 CAS、设备/CSRF 摘要、操作原子认领及状态转换、早期会话 ID、重启派发隔离、双重保留期限清理。
- 安装级 0600 HMAC key 不入库；重启摘要一致，已有操作时缺失/损坏 key 拒绝启动。
- 聚焦 8 pass，全套 189 pass；`bun run typecheck`、`bun run build` 通过。运行数据库尚未迁移。

## Task 4：配对与鉴权核心

- 内存 MAC 配对码、过期/一次性/进程重启失效、每来源/每码/全局限速、高熵会话与 CSRF 摘要、Cookie 及 Host/Origin 校验。
- 私有 socket 只允许单次有界 pair.create；活跃 socket 不替换，非 socket 与 symlink 拒绝，owner-private stale socket 可恢复。
- `web:pair` CLI 已添加，尚未接入运行服务，未生成真实配对码。聚焦测试通过，完整测试 195 pass（随后新增 stale 测试单独通过）；类型检查、构建和 diff 检查通过。

## Task 5：脱敏策略

- 永久凭证过滤与可选展示隐私过滤分层；响应使用一个设置版本快照。原始 prompt 保持不变，新增存储只接收永久过滤后的副本。
- 共享新增 filterSecretText，不改变原有 redact 行为；覆盖已知值、嵌套/多行、URL、Bearer/Cookie、私钥、手机号、邮箱、IPv4/IPv6、绝对路径。
- 聚焦 5 pass，全套 199 pass；类型、构建和 diff 检查通过。跨设备 SSE 尚未接入，未宣称运行同步已完成。

## Task 6：Codex Web adapter 与有界历史

- 仅核对本机记录结构，未复制真实内容；fixture 保存确认的 user/input_text 和 assistant/final_answer/output_text 形状。
- 路径 confinement、普通文件/no-follow 检查、256 KiB 单页与 64 MiB 文件上限、倒序 byte cursor；不展示工具或 reasoning。
- 目录缓存合并并发，Web raw prompt、按请求模型、首轮 owner gate、早期 session callback、外部审批状态投影、queue/failed/unknown 分离。
- 全套 203 pass；`bun run typecheck` 与 `git diff --check` 通过。数据库派发顺序的 HTTP 集成验证归 Task 8，不以 adapter 代替该证据。

## Task 7：dsh Web adapter

- 读写门控、未知旧会话项目、exact-turn 最终回复、有界 cursor、注入式 Web 快照合并、合并并发目录缓存。
- Web 独立 request/session 命名空间、按请求模型、创建早期 ID、busy 不排队、派发丢失为 unknown；无 Telegram store/manager 引用。
- 全套 204 pass；`bun run typecheck`、`git diff --check` 通过。真实 Host Web 操作验收仍待生命周期集成后执行。

## Task 8：API/SSE 集成进度

- API 鉴权/CSRF、有界 JSON 读取、设置 CAS、设备撤销、control-only SSE、目录/会话/历史/操作/日志查询、原始 prompt 与过滤副本分离、派发前持久化认领。
- 接入 Web 与 Telegram 历史投递的只读操作记录；Telegram getStatus 仅投影现有 polling 状态。
- Loopback HTTP 服务与静态 allowlist/CSP 已实现，但静态资源尚未生成，其实测响应门槛仍未勾选。
- 全套 207 pass；类型检查、构建、diff 检查通过。未启动真实 Web 服务。

## Task 9：无依赖网页与静态响应

- 配对、概览、会话、创建/续发、操作/日志、全局设置和设备撤销页面；桌面三栏、手机列表/详情分屏。
- 纯文本 DOM、内存状态、同查询并发合并、设置版本检查、SSE 断开清空、明确 queued/unknown 状态、只做手动核查。
- Loopback 实际 HTTP 测试验证静态 CSP/no-store/nosniff、allowlist 和缺失资源 fail-soft；静态结构检查不替代浏览器验收。
- 全套 209 pass；类型、构建、diff 检查通过。目标浏览器交互仍待 Task 12。

## Task 10：独立构建产物

- Bun 构建 main.js/server.js，并复制 Web 三个静态资源；不递归清理操作员指定路径。
- 临时构建目录动态载入 server.js，资产路径指向该目录的 web，实际请求 HTML/JS/CSS/API 均成功。
- 全套 210 pass；类型、构建、diff 检查通过。

## Task 11：主进程集成

- WebRuntime 只在开启时构造；复用既有 Codex/dsh clients，新增线程通知 baselining 标记，不修改 Telegram 默认模型。
- HTTP/control/SSE/retention 生命周期、派发恢复、构建资源路径集成；关闭 Web 在 core clients 和数据库之前执行。
- 全套 211 pass；类型、构建、diff 检查通过。
- 目标服务当前运行旧 release `cfdee7c`，尚未部署本功能。实际 launch agent 使用 releases 下的启动脚本，中央 env 为 0600、尚无 Web 配置。
