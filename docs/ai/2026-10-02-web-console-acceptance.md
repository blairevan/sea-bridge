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
