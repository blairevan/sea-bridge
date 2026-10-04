# Sea-Bridge 部署与运维指南

适用：macOS、Bun、Cloudflare 固定域名 Tunnel、Sea-Bridge 单管理员账号密码登录。2026-10-04 根据源码和运行配置核对，当前发布版本 v0.14.1。公开文档中的域名、Tunnel UUID 和用户目录均已替换为示例值，不能原样连接维护者的部署；使用时以你自己的配置为准。

## 1. 访问链路与密码所在位置

```text
iPhone / 浏览器
  → https://code.example.com
  → Cloudflare
  → Mac 上的 cloudflared Tunnel
  → http://127.0.0.1:7310
  → Sea-Bridge 账号密码登录
  → Codex / 可选 dsh
```

应用只监听本机 `127.0.0.1`，不需要给路由器做 7310 端口映射，也不需要手机连接 Tailscale。

**域名不设置密码。** DNS 负责把域名指向 Tunnel；Tunnel 负责把请求送到 Mac；账号密码由 Sea-Bridge 在本机设置，浏览器访问域名后显示应用登录页。当前方案仅使用应用账号密码，没有叠加 Cloudflare Access 邮箱登录。

Cloudflare Tunnel 创建、DNS 路由与指定配置运行的流程以 [Cloudflare 官方指南](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/) 为参考。本文采用本地管理的独立 Tunnel 配置，避免和机器上其他 Tunnel 混用。

## 2. 部署位置示例

| 项目 | 当前配置 |
| --- | --- |
| 源码目录 | `/opt/app/aitools/sea-bridge` |
| 发布目录 | `/opt/app/aitools/sea-bridge-releases/sea-bridge-v0.14.1-20261004-170828` |
| 本机地址 | `http://127.0.0.1:7310` |
| 公网地址 | `https://code.example.com` |
| 应用环境配置 | `~/.config/sea-bridge/env` |
| 应用 LaunchAgent | `~/Library/LaunchAgents/com.aitools.sea-bridge.plist` |
| Tunnel 名称 | `sea-bridge-m5` |
| Tunnel UUID | `00000000-0000-4000-8000-000000000000` |
| Tunnel 配置 | `~/.cloudflared/sea-bridge-m5.yml` |
| Tunnel LaunchAgent | `~/Library/LaunchAgents/com.example.sea-bridge-cloudflared.plist` |
| 应用数据库 | `~/Library/Application Support/SeaBridge/sea-bridge.sqlite3` |
| 本机账号控制 socket | `~/Library/Application Support/SeaBridge/run/web-control.sock` |
| Web 操作密钥文件 | `~/Library/Application Support/SeaBridge/web-operation.key` |

发布目录是版本快照；修改源码或执行构建不会自动切换运行中的服务。实际启动路径以 LaunchAgent 的 `ProgramArguments` 为准。

核对运行状态：

```bash
launchctl print "gui/$(id -u)/com.aitools.sea-bridge"
launchctl print "gui/$(id -u)/com.example.sea-bridge-cloudflared"
lsof -nP -iTCP:7310 -sTCP:LISTEN
```

正常应显示服务 `running`，7310 监听地址是 `127.0.0.1`。

## 3. 当前机器：启动、重启与停止

### 3.1 已加载的服务重启

```bash
launchctl kickstart -k "gui/$(id -u)/com.aitools.sea-bridge"
launchctl kickstart -k "gui/$(id -u)/com.example.sea-bridge-cloudflared"
```

只改环境配置时重启应用；只改 Tunnel YAML 时重启 Tunnel。若修改了 plist 中的启动路径或环境变量，必须重新加载 plist，见下一节；仅 kickstart 会继续使用已加载的配置。

### 3.2 未加载的服务启动

```bash
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.example.sea-bridge-cloudflared.plist"
```

服务已加载时不要重复 bootstrap。先用 `launchctl print` 判断状态。

### 3.3 修改 plist 后重新加载

```bash
plutil -lint "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
launchctl bootout "gui/$(id -u)/com.aitools.sea-bridge"
# 等待旧进程退出、7310 释放后再执行下一条。
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.aitools.sea-bridge.plist"
```

Tunnel 同理，把标签和 plist 文件名替换为 `com.example.sea-bridge-cloudflared`。刚 bootout 后可能短暂出现 `Bootstrap failed: 5`；确认旧进程退出和 plist 语法正常后重试 bootstrap，不要反复启动多个前台实例。

### 3.4 停止

```bash
launchctl bootout "gui/$(id -u)/com.aitools.sea-bridge"
launchctl bootout "gui/$(id -u)/com.example.sea-bridge-cloudflared"
```

LaunchAgent 在用户登录后启动，不是登录前的系统服务。Mac 必须保持开机、用户会话可用和网络连接；系统睡眠期间不能保证手机访问。

## 4. 应用环境配置

使用编辑器打开 `~/.config/sea-bridge/env`。该文件按 shell 配置加载，包含敏感信息，保持权限 `0600`，不要提交到 Git。

```bash
mkdir -p "$HOME/.config/sea-bridge"
chmod 700 "$HOME/.config/sea-bridge"
# 新机器才创建；已有配置不要覆盖。
test -f "$HOME/.config/sea-bridge/env" || touch "$HOME/.config/sea-bridge/env"
chmod 600 "$HOME/.config/sea-bridge/env"
```

配置示例中的三项 Telegram 值需要在本机自行填写；这里故意留空，不是可直接运行的完整配置：

```bash
TELEGRAM_BOT_TOKEN=
ALLOWED_USER_ID=
ALLOWED_CHAT_ID=

SEA_BRIDGE_WEB_ENABLED=true
SEA_BRIDGE_WEB_PORT=7310
SEA_BRIDGE_WEB_REMOTE_ORIGIN=https://code.example.com
SEA_BRIDGE_BUN_BIN="$HOME/.bun/bin/bun"

SEA_BRIDGE_DB_PATH="$HOME/Library/Application Support/SeaBridge/sea-bridge.sqlite3"
SEA_BRIDGE_HOOK_SOCKET="$HOME/Library/Application Support/SeaBridge/run/codex-hook.sock"
SEA_BRIDGE_WEB_CONTROL_SOCKET="$HOME/Library/Application Support/SeaBridge/run/web-control.sock"
SEA_BRIDGE_WEB_OPERATION_PEPPER_PATH="$HOME/Library/Application Support/SeaBridge/web-operation.key"
SEA_BRIDGE_LOG_LEVEL=info
```

| 配置项 | 默认值 / 用途 |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | 必填；Telegram Bot token，在 BotFather 管理 |
| `ALLOWED_USER_ID` | 必填；允许使用桥接的 Telegram 用户 ID |
| `ALLOWED_CHAT_ID` | 必填；允许的聊天 ID，与用户 ID 不一定相同 |
| `SEA_BRIDGE_WEB_ENABLED` | 默认 false；启动网页服务必须设 true |
| `SEA_BRIDGE_WEB_PORT` | 默认 7310；改动后 Tunnel 的 service 端口也要改 |
| `SEA_BRIDGE_WEB_REMOTE_ORIGIN` | 默认空；远程访问必须设置精确的 HTTPS origin |
| `SEA_BRIDGE_BUN_BIN` | 启动脚本使用；建议填 `command -v bun` 得到的绝对路径 |
| `SEA_BRIDGE_DB_PATH` | 应用数据库；修改会切换数据源，包括账号和会话 |
| `SEA_BRIDGE_WEB_CONTROL_SOCKET` | 本机设置账号的控制通道；CLI 和服务必须一致 |
| `SEA_BRIDGE_WEB_OPERATION_PEPPER_PATH` | 自动创建的操作摘要密钥；迁移时一起保留 |
| `SEA_BRIDGE_CODEX_STATE_DB_PATH` | 默认 `~/.codex/state_5.sqlite` |
| `SEA_BRIDGE_CODEX_THREAD_HISTORY_DB_PATH` | 默认 `~/.codex/thread_history_1.sqlite` |
| `SEA_BRIDGE_CODEX_CLI_PATH` | 可显式指定可执行 Codex CLI；未指定时按源码规则探测 |
| `CODEX_HOME` | 默认 Codex 状态库所在目录；需要与使用的 Codex 用户一致 |

当前完整应用启动仍要求三项 Telegram 配置，即使主要通过网页使用。不要把网页登录密码写入这个环境文件；它通过本机命令设置。

`SEA_BRIDGE_WEB_REMOTE_ORIGIN` 必须写成 `https://code.example.com`，不能带末尾 `/`、路径、账号或密码。它也是 Host/Origin 白名单；换域名后需要同步修改并重启应用。不要在 Tunnel 中将 HTTP Host 改成 localhost，否则可能被拒绝为 403。

可选 dsh 功能：

```bash
SEA_BRIDGE_DSH_READ_ONLY_ENABLED=true
SEA_BRIDGE_DSH_WRITE_ENABLED=true
SEA_BRIDGE_DSH_NOTIFICATIONS_ENABLED=true
# 默认连接位置：~/.dsh/run/sea-bridge.sock 和 ~/.dsh/run/sea-bridge.token
```

write 和 notifications 都依赖 read-only 开关开启。只有 Codex 时可不设置这些开关。dsh 连接器需单独安装并启动宿主；可先运行 `bun run dsh-connector:check`，安装命令是 `bun run dsh-connector:install`。连接器安装不等于宿主服务已运行。

## 5. 设置网页登录账号与密码

### 5.1 首次设置

先确认新版应用和 Web 服务正在运行，再在 **Mac 本机真实终端**执行：

```bash
cd /opt/app/aitools/sea-bridge
set -a
source "$HOME/.config/sea-bridge/env"
set +a
bun run web:account
```

依次输入账号、密码、再次确认密码。密码输入不回显。

- 账号：3–64 个字符，允许英文字母、数字、`_`、`.`、`-`，首位必须是字母或数字。
- 密码：12–256 个字符，不允许控制字符或全部空白；前后空格属于密码内容。
- 只有一个管理员账号；再次执行会替换账号和密码，没有默认密码、公开注册或邮件找回。
- CLI 不接受密码参数、管道或重定向输入。不要把密码放进命令行或 shell 历史。
- 数据库保存 Argon2id 哈希；登录会话和 CSRF 值仅保存哈希。

看到“账号已设置，所有旧登录已失效”后，在 iPhone 打开 `https://code.example.com`，输入刚设置的账号密码。

### 5.2 修改账号、忘记密码或重置密码

执行与首次设置完全相同的命令。**重置会立即撤销全部旧设备登录**，关闭已连接的实时流；需要在每台设备重新登录，不会删除聊天历史或桥接操作记录。

不需要更改 DNS、Tunnel 或 Cloudflare 账号密码，也不需要重新部署代码。不要直接编辑 `web_admin_account` 表来绕过重置流程。

### 5.3 登录行为与限制

- 会话有效期为 30 天；网页提供退出登录和逐设备撤销。
- 远程密码登录要求 HTTPS；本机 `http://127.0.0.1:7310` 可用于检查。
- 每个登录来源每分钟最多 5 次尝试、全局最多 30 次，密码校验最多同时 2 个；成功登录也计入尝试次数。
- 当前远程请求共享限流桶，不能通过切换手机网络规避；过于频繁时等待约一分钟再试。
- 仅账号密码方案下，能访问登录接口的人可能消耗共享额度造成可用性影响。当前没有外层 Access 门禁；如果以后启用，需要单独配置 Access，应用密码仍保留。

## 6. 新机器从零准备

以下步骤只在新机器或明确重装时执行，**当前 Mac 已完成的步骤不要重复执行**。

1. 准备 macOS 用户会话、Bun、Python 3、cloudflared；当前验证版本为 Bun 1.4.2、cloudflared 2026.8.2。安装路径用 `command -v` 确认。
2. 将源码放在 `/opt/app/aitools/sea-bridge`，确保可读取，并按第 4 节填写环境配置。
3. 同一用户安装并登录 Codex，确认状态库存在；Codex CLI 的实际可执行路径不能只按应用名称猜测。
4. 安装项目已有依赖，完成构建和检查。仓库现有锁文件为 `pnpm-lock.yaml`；若使用 pnpm，执行 `pnpm install --frozen-lockfile`。依赖安装不需要增加新依赖，也不要为了部署修改锁文件。

```bash
cd /opt/app/aitools/sea-bridge
command -v bun
command -v python3
command -v cloudflared
bun --version
cloudflared --version
bun run typecheck
node --check src/web/public/app.js
bun test
bun run build
```

前台试运行，确认本机接口后再安装后台服务。不要与现有 LaunchAgent 实例同时运行：

```bash
cd /opt/app/aitools/sea-bridge
./scripts/run-sea-bridge.sh
```

源码中的启动脚本加载环境文件并运行 `src/main.ts`。发布快照的脚本则运行 `dist/main.js`，二者不要混淆。前台运行按 Ctrl+C 停止。

如果需要 Codex hooks 观察与审批，先审阅 `bun run scripts/install-codex-hooks.ts --dry-run` 的结果，再执行 `bun run scripts/install-codex-hooks.ts`。安装器备份并合并 hooks 配置；仍需按当前 Codex 版本确认 hooks 功能是否启用，安装文件不等于运行时生效。

## 7. Cloudflare 域名与 Tunnel 配置

### 7.1 当前机器检查现有 Tunnel

```bash
cloudflared tunnel list
cloudflared tunnel --config "$HOME/.cloudflared/sea-bridge-m5.yml" ingress validate
cloudflared tunnel --config "$HOME/.cloudflared/sea-bridge-m5.yml" ingress rule https://code.example.com
```

每次明确传 `--config`，避免默认 `~/.cloudflared/config.yml` 指向其他应用。当前使用 UUID `00000000-0000-4000-8000-000000000000`，不要重新创建同名 Tunnel。

### 7.2 新机器或新域名：创建流程

域名 DNS 区域需要接入 Cloudflare；有一个已购买的域名还不够，需确认其 DNS 由有权限的 Cloudflare 账号管理。

```bash
cloudflared tunnel login
cloudflared tunnel create sea-bridge-m5
```

首次登录浏览器选择所属域名区域。记录输出中的实际 UUID 和凭据 JSON 路径。`cert.pem` 和 Tunnel JSON 都是凭据，不能复制进文档或 Git；新机器不要直接套用当前机器的 UUID，除非有意迁移同一个 Tunnel 并已安全转移对应凭据。

新建 `~/.cloudflared/sea-bridge-m5.yml`，内容参考下面。`YOUR_TUNNEL_UUID` 和 `/ABSOLUTE/HOME` 必须换成实际值，YAML 不会按 shell 方式展开 `$HOME`：

```yaml
tunnel: YOUR_TUNNEL_UUID
credentials-file: /ABSOLUTE/HOME/.cloudflared/YOUR_TUNNEL_UUID.json
protocol: http2
ingress:
  - hostname: code.example.com
    service: http://127.0.0.1:7310
  - service: http_status:404
```

按 [Cloudflare 配置文档](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/configuration-file/) 校验 ingress；最后一项是兜底规则。这里沿用当前机器的 HTTP/2 协议，本机上游为 HTTP，浏览器访问仍是 HTTPS。

```bash
cloudflared tunnel --config "$HOME/.cloudflared/sea-bridge-m5.yml" ingress validate
cloudflared tunnel route dns YOUR_TUNNEL_UUID code.example.com
cloudflared tunnel --config "$HOME/.cloudflared/sea-bridge-m5.yml" run YOUR_TUNNEL_UUID
```

DNS 命令创建指向 `YOUR_TUNNEL_UUID.cfargotunnel.com` 的 CNAME。若域名已有记录，先在 Cloudflare 控制台确认它属于哪个服务，不要盲目覆盖。控制台手工配置时，记录名为 `code`，目标为实际 UUID 的 `.cfargotunnel.com` 域名，开启代理。

前台验证成功后，停止前台 Tunnel，再用下一节 LaunchAgent 启动。不要同时运行多个意外重复实例。

### 7.3 换域名或换端口

换域名时同步修改 Tunnel `hostname`、DNS 路由和应用 `SEA_BRIDGE_WEB_REMOTE_ORIGIN`。换端口时同步修改 `SEA_BRIDGE_WEB_PORT` 和 Tunnel `service`。之后重启相关服务并验收。

仅换域名不需要重设应用密码，但原域名的浏览器 Cookie 不会自动转移到新域名，需要重新登录。

## 8. 创建后台启动配置

当前机器已有这两份 plist，不需要重建。新机器可用以下 Python 模板生成；代码在已有目标文件时拒绝覆盖。执行前确认路径和 Tunnel UUID，`SEA_DEPLOY_RELEASE` 必须指向准备好的发布快照。

```bash
export SEA_DEPLOY_RELEASE=/opt/app/aitools/sea-bridge-releases/实际发布目录
export SEA_DEPLOY_TUNNEL_UUID=实际TunnelUUID
python3 - <<'PY'
import os, pathlib, plistlib, shutil
home = pathlib.Path.home()
release = pathlib.Path(os.environ['SEA_DEPLOY_RELEASE'])
runner = release / 'scripts/run-sea-bridge.sh'
assert runner.is_file(), '发布启动脚本不存在'
cloudflared = shutil.which('cloudflared')
assert cloudflared, 'cloudflared 未安装'
agents = home / 'Library/LaunchAgents'
logs = home / 'Library/Logs'
agents.mkdir(parents=True, exist_ok=True)
(logs / 'SeaBridge').mkdir(parents=True, exist_ok=True)
documents = {
    'com.aitools.sea-bridge': {
        'ProgramArguments': ['/bin/zsh', str(runner)],
        'WorkingDirectory': '/opt/app/aitools/sea-bridge',
        'EnvironmentVariables': {'HOME': str(home), 'PATH': f'{home}/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'},
        'StandardOutPath': str(logs / 'sea-bridge.log'),
        'StandardErrorPath': str(logs / 'sea-bridge.error.log'),
    },
    'com.example.sea-bridge-cloudflared': {
        'ProgramArguments': [cloudflared, 'tunnel', '--config', str(home / '.cloudflared/sea-bridge-m5.yml'), 'run', os.environ['SEA_DEPLOY_TUNNEL_UUID']],
        'StandardOutPath': str(logs / 'SeaBridge/cloudflared.log'),
        'StandardErrorPath': str(logs / 'SeaBridge/cloudflared.error.log'),
    },
}
for label, fields in documents.items():
    path = agents / f'{label}.plist'
    with path.open('xb') as output:
        plistlib.dump({'Label': label, 'RunAtLoad': True, 'KeepAlive': True, **fields}, output)
    path.chmod(0o600)
PY
```

按第 3 节 bootstrap 后检查进程。本例的 PATH 对 Apple Silicon 常见安装位置适用；Intel Mac 或自定义安装需调整。凭据放环境文件，不放 plist。两个服务分别管理，应用重启不需要同时重启 Tunnel。

## 9. 发布升级、备份与回退

推荐保持版本快照，不让运行进程直接依赖正在修改的源码目录。

1. 核对分支和改动，递增 `package.json` 版本；HTML 和 JS/CSS URL 读取该版本，避免浏览器继续使用旧缓存。
2. 执行第 6 节的检查和 `bun run build`。
3. 新建带时间戳的发布目录，复制 `dist/`、`package.json` 和发布启动脚本；不要复制 `.env`、数据库、凭据或 `node_modules`。
4. 备份现有 plist 与 SQLite，保留旧发布目录。运行中 SQLite 使用备份 API，不要单独复制正在写入的数据库主文件。
5. 修改应用 plist 的脚本路径，bootout/bootstrap 重新加载，再检查新版本和资源。

创建发布快照示例（仅生成文件，不切换服务）：

```bash
cd /opt/app/aitools/sea-bridge
python3 - <<'PY'
import datetime, json, pathlib, shutil
root = pathlib.Path.cwd()
version = json.loads((root / 'package.json').read_text())['version']
release = root.parent / 'sea-bridge-releases' / f'sea-bridge-v{version}-{datetime.datetime.now():%Y%m%d-%H%M%S}'
release.mkdir(parents=True, mode=0o700)
shutil.copytree(root / 'dist', release / 'dist')
shutil.copy2(root / 'package.json', release / 'package.json')
(release / 'scripts').mkdir()
script = (root / 'scripts/run-sea-bridge.sh').read_text()
assert 'exec "$BUN_BIN" run src/main.ts' in script
(release / 'scripts/run-sea-bridge.sh').write_text(script.replace('exec "$BUN_BIN" run src/main.ts', 'exec "$BUN_BIN" run dist/main.js'))
(release / 'scripts/run-sea-bridge.sh').chmod(0o700)
print(release)
PY
```

SQLite 一致性备份示例（只读打开运行库，备份目录私有）：

```bash
python3 - <<'PY'
import datetime, pathlib, sqlite3
home = pathlib.Path.home()
source = home / 'Library/Application Support/SeaBridge/sea-bridge.sqlite3'
# 自定义 SEA_BRIDGE_DB_PATH 时，这里必须改为实际路径。
directory = home / '.config/sea-bridge/backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S')
directory.mkdir(parents=True, mode=0o700)
target = directory / 'state.sqlite3'
with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src:
    with sqlite3.connect(target) as dst:
        src.backup(dst)
        assert dst.execute('PRAGMA quick_check').fetchone()[0] == 'ok'
target.chmod(0o600)
print(target)
PY
```

另行安全备份环境文件、操作密钥和 Tunnel 凭据。备份包含账号哈希和会话凭据，不能公开分享。

回退优先恢复旧应用 plist 或改回旧发布脚本路径，再重新加载。不要默认回滚数据库：旧版本可能不兼容新迁移，恢复旧数据库也会丢失备份之后的数据，并可能恢复旧会话；这需要停止服务、确认迁移兼容性和数据影响后单独操作。

## 10. 部署验收与故障排查

### 10.1 不登录也可以完成的检查

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7310/
curl -sS -o /dev/null -w '%{http_code}\n' https://code.example.com/
curl -sS -o /dev/null -w '%{http_code}\n' https://code.example.com/api/auth/session
cloudflared tunnel --config "$HOME/.cloudflared/sea-bridge-m5.yml" ingress validate
```

本机和域名首页正常应为 200；未登录请求 session 接口应为 401，这是认证生效，不是部署失败。浏览器显示预期版本，再登录验证项目目录、历史消息和实际发送；静态 200 不代表 Codex/dsh 的全部业务已经可用。

### 10.2 日志位置

```bash
tail -n 80 "$HOME/Library/Logs/sea-bridge.error.log"
tail -n 80 "$HOME/Library/Logs/sea-bridge.log"
tail -n 80 "$HOME/Library/Logs/SeaBridge/cloudflared.error.log"
tail -n 80 "$HOME/Library/Logs/SeaBridge/cloudflared.log"
```

分享日志前检查并遮盖 token、账号和消息内容。不要输出整个环境文件、凭据 JSON 或数据库来排查。

| 现象 | 检查与处理 |
| --- | --- |
| 本机 7310 连不上 | 查 LaunchAgent、监听和错误日志；确认 WEB_ENABLED=true、端口正确；Web 启动失败可能只记录 web_start_failed 而核心进程仍运行 |
| 本机正常、域名失败 | 查 Tunnel 进程、配置、ingress、DNS 和 Mac 网络；确认 service 指向 127.0.0.1:7310 |
| 页面或 API 403 | 检查精确 remote origin、浏览器 Origin 和 Host；确认 Tunnel 没有改写成 localhost；也要区分 Cloudflare 边缘拒绝与应用拒绝 |
| 登录一直失败 | 确认已执行 web:account、服务使用的是同一个数据库；检查账号大小写、密码空格和每分钟尝试限制 |
| CLI 设置账号失败 | 必须真实 TTY；服务已启动；CLI 环境与服务 socket 路径相同；不要传密码参数或管道 |
| 重置后手机退出登录 | 预期行为，旧会话已撤销，使用新凭据重新登录 |
| 页面仍是旧版本 | 查 LaunchAgent 实际发布路径；确认版本递增、bootstrap 重新加载，然后刷新浏览器 |
| 项目/模型目录不可用 | 检查 Codex 用户、CLI 与状态库；dsh 检查连接器和宿主，不要靠重设网页登录密码解决 |
| Bootstrap failed: 5 | 查 plist 语法、旧进程是否退出、目标脚本是否存在；稍后重试加载并查看 launchctl print |
| Tunnel 凭据找不到 | YAML 使用实际绝对路径，确认当前用户能读取对应 JSON；不要复制其他 Tunnel 的凭据冒充 |

### 10.3 本文编写时的验证边界

已只读核对两个 LaunchAgent 均 running，当前应用启动指向 v0.14.1 发布目录；域名首页返回 200，未认证 session 返回 401，Tunnel ingress validate 通过。本文没有重置密码、重复创建 DNS/Tunnel 或重启现有服务；新机器模板没有在本机覆盖执行。
