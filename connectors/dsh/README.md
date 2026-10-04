# dsh 宿主连接器

Sea-Bridge 的可选 Cordis 插件，运行在 dsh Web Host 内。正式插件版本为 `0.4.0`，不是独立 Web 服务，也不负责 Codex 接入。

## 文件结构

- `index.mjs`：插件生命周期、本机 Socket 和请求鉴权。
- `host-operations.mjs`：固定的宿主读写操作与返回值裁剪。
- `cordis.patch.yml`：将插件挂载到宿主的配置片段。
- `package.json`：ESM 插件元信息，无第三方依赖。
- `index.test.mjs`：Socket、安全边界和宿主操作测试。

诊断与恢复工具位于 [`../../scripts/dsh/`](../../scripts/dsh/README.md)。原 `poc/dsh-web-connector/` 已拆分，不再作为安装源。

## 安装与检查

需要本机已安装 dsh，宿主提供 `sessionController` 和 `workspaceRegistry`。在 Sea-Bridge 仓库根目录执行：

```bash
bun run dsh-connector:install
bun run dsh-connector:check
```

安装脚本只复制四个运行文件到 `~/.dsh/connectors/sea-bridge/`，并验证哈希及私有文件权限；设置 `DSH_HOME` 可以改变根目录。测试、说明和诊断脚本不会安装到宿主。

安装不会自动修改宿主配置或重启宿主。将 `cordis.patch.yml` 的插件项合并到实际使用的 Cordis 配置中；该片段的 `./index.mjs` 必须相对于已安装插件目录解析。确认宿主实际配置后再重启 dsh。

## 通信与边界

连接器通过 `~/.dsh/run/sea-bridge.sock` 接收本机请求，并使用同目录下私有 token 文件鉴权。它提供会话、项目、模型和历史读取，以及受限制的会话操作。具体操作以 `host-operations.mjs` 的白名单为准，不提供任意 RPC。

运行目录、Socket 和 token 需由当前用户持有且不能对其他用户开放。不要将 token 文件上传或提交到仓库。

## 验证

```bash
node --test connectors/dsh/index.test.mjs scripts/dsh/recover-metadata.test.mjs
bun run typecheck
bun test
```

单元测试使用模拟宿主，不代表真实 dsh 已接入。运行时检查需在安装并挂载后进行。
