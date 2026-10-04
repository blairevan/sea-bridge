# dsh 诊断与恢复工具

这些工具面向维护者，不属于宿主插件的安装文件。正式插件和安装说明见 [`../../connectors/dsh/`](../../connectors/dsh/README.md)。

在仓库根目录运行：

```bash
node scripts/dsh/probe-health.mjs
node scripts/dsh/probe-reads.mjs
node scripts/dsh/probe-live.mjs
node scripts/dsh/probe-terminal.mjs
bun scripts/dsh/probe-bridge.ts
```

各探测工具需要已运行并挂载连接器的 dsh 宿主；具体前提和参数见脚本。失败时不要把 token 内容复制到日志或反馈中。

`recover-metadata.mjs` 是恢复逻辑模块，由 live 探测及其测试使用。

`run-health-poc.sh` 保留为早期宿主试装工具：它会临时切换 LaunchAgent，且检查固定宿主路径、Node 版本与端口。不是通用启动脚本，也不要在日常部署时执行。保留原名以明确其试验用途。

恢复逻辑测试：

```bash
node --test scripts/dsh/recover-metadata.test.mjs
```
