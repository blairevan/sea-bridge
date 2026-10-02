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
