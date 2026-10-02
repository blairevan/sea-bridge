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

## Task 12：本机部署与待验收边界

- 在当前 checkout 的 `feature/web-console` 分支实施；按用户指令不使用 worktree。
- 实际服务为 `com.aitools.sea-bridge`，plist 位于 `~/Library/LaunchAgents/com.aitools.sea-bridge.plist`，中央 env 为 `~/.config/sea-bridge/env`（0600）。原配置已保存在 owner-private backups 目录。
- 已部署独立 release 并启用 Web；远程 origin 保持未设置。实际监听仅 `127.0.0.1:7310`，首页 HTTP 200，未鉴权 API HTTP 401。dsh、hook 和 Telegram polling 启动事件正常。
- 首次 launchd reload 遇到异步移除造成 bootstrap 失败；已恢复原配置并确认旧服务启动，再通过有界重试完成部署。
- 复查补上设备名称永久过滤、创建操作手动核查入口、断线期间在途敏感响应拒绝；断线回归先失败后通过。数据库升级 fixture 验证 Telegram/desktop/dsh 既有记录保留。
- 当前全套 212 pass / 0 fail；类型检查、构建、diff 检查通过。没有 lint/format script，未新增依赖。
- 临时浏览器配对和全局隐私设置切换等待用户当场确认；真实 Codex/dsh 创建/续发、跨设备同步和撤销尚未验收。
- Tailscale 只做只读预检：服务 Running，现有 TCP 13080 转发保留，未发现启用 Funnel；未配置新的 Serve 路由。Task 13 必须等本机验收通过。手机及第二台电脑结果尚未取得。

## 2026-10-02 代码复审修订

本轮按设计与实施计划重新审查 Web 鉴权、操作状态机、Codex/dsh source adapter、历史合并、操作记录、SSE 恢复和 Tailscale Serve 信任边界，并直接修复以下问题：

- Web 操作的消息快照改为在来源派发边界之前落盘；若本地快照持久化失败，操作明确进入 `failed/local_persistence_failed`，不会误报为来源可能已执行。
- 明确失败的 Web 写操作不再留下可用于会话历史的用户快照；dsh 历史只合并 `accepted` 操作，避免 busy、validation failed、delivery unknown 被伪造成真实用户消息。
- dsh 写入在 Host 调用前执行 8192 字符上限和 session ID 校验；项目/模型发现失败属于明确的前置失败，不再误标为 `delivery_unknown`。模型选择明确拒绝与首条 prompt 明确拒绝也保持 definite failure。
- Codex 项目/模型发现失败发生在 `thread/start` 前时返回明确失败；只有进入 App Server 创建边界后的异常才保留 unknown。
- Codex 与 dsh 的 sessions/projects/models/history 能力证据拆分，不再因一个读取接口成功就把其它接口标成可用。
- dsh exact-turn summary 增加有界内存缓存，避免前台 3 秒刷新对同一 durable turn 重复串行读取。
- 操作记录把筛选条件下推到各 provider SQL 后再做有界读取，修复“先 LIMIT、后过滤”遗漏较旧匹配记录；同时纳入已有持久状态可可靠重建的 Telegram dsh 新建会话记录。Codex 历史 Telegram 新建没有同等结果表，不做推断。
- Tailscale Serve 配对限速桶在已满足精确远程 Host + loopback backend 条件后，使用 `Tailscale-User-Login` 的截断 SHA-256 摘要区分用户；不保存完整身份字符串，tagged/no-identity 流量落入匿名远程桶，身份头仍不参与 Sea-Bridge 授权。
- 永久凭证过滤补齐 `Cookie=` / `Set-Cookie=` 等等号形式。
- 页面从后台恢复时，只有 SSE 已重新进入 `OPEN` 才解除敏感展示暂停；否则继续清空敏感内容。已收到明确 4xx 前置错误的提交不再误提示“结果待确认”，只有网络/服务端不确定结果保留人工核查。
- 部分创建失败/unknown 且已知 session ID 时，页面明确显示“已创建会话 <id>”，避免用户重复创建。

复审后验证：
- Web 专项：45 pass / 0 fail。
- 全量：221 pass / 0 fail。
- `bun run typecheck`：通过。
- `bun run build`：通过。
- `git diff --check`：通过。
- 未执行真实浏览器配对、全局脱敏切换、设备撤销；未修改 Tailscale Serve/Funnel。上述仍属于运行态验收。

## 本轮限定运行验收（2026-10-02）

- 用户授权范围：仅配对一个临时设备、全局脱敏关闭一次后立即恢复开启、撤销该设备；不含 Tailscale 配置修改或真实 Codex/dsh 写入。
- 复审代码重新执行 `bun test`（221 pass / 0 fail）、`bun run typecheck`、`bun run build`、`git diff --check`，全部通过。
- 将当前未提交源码及新构建产物快照部署到 `sea-bridge-releases/web-review-20261002-155317`；release 启动脚本执行 `dist/main.js`。原 env 与 Tailscale 配置未修改，未提交、未 push。
- 浏览器成功配对唯一临时设备 `临时验收-20261002`；设置页面初始开启，关闭并保存一次，确认关闭后立即开启并保存。
- 随后撤销当前临时设备，页面显示“设备已被撤销，请重新配对”；直接读取实际进程持有的数据库确认脱敏开启、设置版本 3，临时设备仅一条且已撤销。
- `lsof -nP -iTCP:7310 -sTCP:LISTEN` 确认仅监听 `127.0.0.1:7310`；未鉴权 `/api/status` 返回 401。
- 截图：`docs/ai/2026-10-02-web-device-revoked.png`。未记录配对码、Cookie 或会话凭证。
- 验收边界：未验证第二设备同步、真实来源写入或手机/Tailnet 访问；Task 12/13 不标为全部完成。

## Tailscale Serve 接入（2026-10-02）

- 用户单独确认接入；新增 HTTPS 443 → http://127.0.0.1:7310，精确 remote origin 为 https://macbookprom5nvy.tail349ac9.ts.net。原 TCP 13080 → 127.0.0.1:3080 保留，无 AllowFunnel。
- env/Serve 原配置备份：~/.config/sea-bridge/backups/tailscale-serve-20261002-161537；移除本次路由命令 `tailscale serve --https=443 off`，并恢复该备份 env 后重启服务。
- M2 (100.96.125.89) 上真实 HTTPS 请求：使用 curl --noproxy '*' --resolve macbookprom5nvy.tail349ac9.ts.net:443:100.112.22.85，首页 200，未鉴权 API 401，证书校验正常。
- 普通 DNS 请求仍失败：M2 将域名解析到 198.18.0.226，属于代理假 IP 地址范围；尚未修改 M2 DNS/代理配置。普通浏览器、手机和远程配对未验收。

## 用户改用 IP 隧道（2026-10-02）

- 按用户最新要求撤掉新增 HTTPS 443 Serve、移除 remote origin 并重启；原 TCP 13080 保留。未修改 M2 DNS，未开启 accept-dns。
- 通过 Tailscale IP 100.96.125.89 建立 SSH reverse loopback forwarding：M2 127.0.0.1:7310 → M5 127.0.0.1:7310。仅运行态隧道，未设置开机自启。
- M2 实际请求 http://127.0.0.1:7310/ 返回 200；未鉴权 /api/status 返回 401。配对码仍需在 M5 生成。隧道依赖 M5 上 SSH 进程，重启后需重建。

## 原生 Tailscale IP 入口（2026-10-02）

- 按用户最新要求，替换 SSH forwarding 为 Tailscale Serve TCP 7310 → 127.0.0.1:7310；旧 SSH 进程已停止，原 TCP 13080 保留，未启用 Funnel。
- 入口 http://100.112.22.85:7310/；应用继续仅监听 loopback，精确配置该 Tailnet HTTP origin。HTTP 仅放行 canonical 100.64.0.0/10 IPv4 origin，Cookie 保留 HttpOnly/SameSite/CSRF；HTTPS 仍保留 Secure。Tailnet TCP 不信任客户端身份头，限速使用共享匿名远程桶。传输加密由 Tailscale 提供。
- 部署 web-tailnet-ip-20261002-163031；224 测试通过，typecheck/build/diff 检查通过。M2 直接 IP 首页 200、未登录 API 401；手机真实访问尚待用户验证。
- 回滚：tailscale serve --tcp=7310 off，恢复 backups/web-tailnet-ip-20261002-163031 下 env/agent.plist 后 reload。代码未提交、未 push。

## M2 系统代理 503 修复（2026-10-02）

- 复现：直连首页 200，显式经 127.0.0.1:1082 HTTP 代理返回 503；此前 --noproxy 验证不能证明浏览器路径正常。
- Shadowrocket 源配置包含 Tailnet 网段绕过，但加载缓存缺失。备份 rule.db 和 iCloud 源 lazy_group.db 到 M2 ~/.config/sea-bridge-proxy-backup，向 skip-proxy 添加精确 100.112.22.85，重新连接 Shadowrocket。
- 验证 Shadowrocket Connected、系统 HTTP/HTTPS 代理仍启用、scutil --proxy 的 ExceptionsList 包含 100.112.22.85。M2 Python urllib 的 macOS proxy_bypass=True，遵循系统代理的首页请求 200，未鉴权 API 401。
- M2 浏览器实际页面和 iPhone 尚待用户验证；未宣称已完成。

## 消息显示与 HTTP 发送兼容（2026-10-02）

- 用户反馈 iPhone HTTP IP 页面 crypto.randomUUID 不可用。增加 crypto.getRandomValues UUID v4 fallback，无 Math.random；保留原幂等操作 ID。fixture 在 randomUUID 缺失时验证标准 version/variant 位。未执行额外真实来源写入。
- 无依赖 Markdown 子集：标题、强调、列表、引用、代码围栏、表格、链接。纯 DOM/textContent，不解析源 HTML；URL 禁止 javascript/data/file 与 userinfo。HTTPS 或同源图片链接需点击加载，no-referrer，不代理本机文件，不支持上传。
- 消息顶部增加来源时间：Codex rollout timestamp、dsh turn/end time、accepted Web snapshot created_at；缺失显示“时间未知”，不伪造历史时间。
- 全套 229 pass / 0 fail；bun run typecheck、bun run build、git diff --check 通过。390×844 浏览器预览验证标题/列表/表格/代码/时间，以及点击图片加载；截图 2026-10-02-message-mobile-preview.png 为合成 fixture，不含真实会话内容。
- 部署 release web-message-ui-20261002-182204；IP 首页和 JS/CSS 返回 200，新资产版本 message1，HTTP 源站监听不变。未提交、未 push。真实 iPhone 发送和历史显示结果待用户反馈。

## 发送后历史刷新修复（2026-10-02）

- 用户截图停留在 18:23:10 回复和“已入队”。核对 Codex 队列当前无该项，rollout 有 18:25:44 用户消息与 18:25:49 最终回复；旧 reader 实际返回空 messages。
- 根因：只扫描尾部 256 KiB，工具/图片大段记录会挤出可见消息。改为最多 16 个 256 KiB 窗口（总扫描不超过 4 MiB），持续跳过不可见记录，保留 no-follow/confinement/64 MiB 文件上限与 byte cursor。新增 700 KiB trailing tool gap 回归测试。真实 rollout 修复后读到该最终回复，只输出角色与时间元数据。
- 发送后跟随最新消息；用户浏览较早历史时不强制跳底。按最后 assistant ID 检测新最终回复，文案“发现新的最终回复”不声称与提交操作存在可靠关联。绝不重发原消息。
- 全套 231 pass / 0 fail；bun run typecheck、bun run build、git diff --check 通过。部署 web-history-refresh-20261002-183222，前端资产 message2；IP 首页/JS 200。手机刷新显示尚待用户确认，未提交、未 push。
## 发送后历史刷新代码复审（2026-10-02）

- 复审发现历史分页状态仍有缺陷：用户加载更早页面后，3 秒最新轮询会覆盖已加载旧消息并把 `historyCursor` 重置到最新页边界，后续“加载更早”会重复取页。已改为最新轮询合并新消息且保留最早 continuation cursor；仅首次加载或显式向前翻页时更新 cursor。
- Codex rollout reader 的窗口边界处理补强：窗口起点若刚好位于 JSONL 行边界，不再误跳首条完整记录；文件末尾完整 JSON 尚未写入换行时也可读取最终回复，部分/非法 JSON 仍忽略。
- 尾部扫描上限由 4 MiB 提升为 16 MiB，仍采用 256 KiB 随机访问窗口；新增 5 MiB 工具/图片尾部回归。此前 64 MiB 的“整个 rollout 文件大小”硬拒绝已移除，因为读取本身已严格有界；改为只要求普通文件和安全整数大小，并用 65 MiB 稀疏文件验证长会话仍可读取。
- HTTP 层原先允许 32,000 字符 Codex prompt，但请求体仅 64 KiB，合法中文长消息会在字段校验前被拒绝。总请求体上限改为 256 KiB，pair 等小接口仍保留各自更小的 `readJson` 上限；新增 32,000 个中文字符通过 HTTP 边界的回归。
- 前端资源版本提升为 `20261002-message3`，用于后续部署时强制区分本轮修订。
- 复审后全量验证：234 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- 本轮只修改当前 `feature/web-console` 工作区源码与测试，未在此复审步骤重新部署运行服务；线上是否仍为 `web-history-refresh-20261002-183222` 无法从当前 DevSpace 容器直接核实。


## message3 部署验收（2026-10-02 19:01）

- 已部署独立 release：`/opt/app/aitools/sea-bridge-releases/web-message3-20261002-190107`，launchd 实际运行 PID 5188。
- 同步静态测试的版本断言：message2 → message3；重新执行 `bun test`：234 pass / 0 fail。
- `bun run typecheck`、`bun run build`、`git diff --check` 通过。
- 经 Tailscale IP 请求首页、message3 JS/CSS 均为 HTTP 200；未授权 `/api/status` 为 401。部署构建与当前 dist 的 SHA-256 一致。
- 服务仅监听 127.0.0.1:7310；原有 Tailscale TCP Serve 7310/13080 配置保持，未启用 Funnel。
- 本轮没有提交或 push；未执行新的真实消息写入，iPhone 刷新后的交互仍需设备侧确认。


## message4 部署验收（2026-10-02 19:22）

- 已部署 release：`/opt/app/aitools/sea-bridge-releases/web-message4-20261002-192245`；launchd 已加载该 release。
- `bun test`：235 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- Tailscale IP 首页及 message4 JS/CSS 返回 200，未授权 status 返回 401；部署构建 SHA-256 与当前 dist 一致。
- 未提交或 push；手机首次进入会话的滚动行为仍需设备侧确认。


## message5 手机会话定位修复（2026-10-02 19:31）

- 原始 rollout 与 reader 可读到 19:23 最终回复；手机点击会话时在 detail-open 前设置 scrollTop，隐藏面板无法保留定位。
- 将显示面板移至加载消息前，新建会话同路径同步修复；回归模拟隐藏面板的 scrollTop 归零，修复前失败、修复后通过。
- `bun test` 236 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- 部署 `/opt/app/aitools/sea-bridge-releases/web-message5-20261002-193103`；IP 首页/JS/CSS 200，未授权 status 401；运行 release 与构建哈希已验证。
## message6 会话最新消息定位修复（2026-10-02 19:50）

- 手机仍停在最早消息的根因确认在布局：`#messages` 虽有 `overflow:auto`，但祖先只有 `min-height`、没有 viewport 高度约束，内容会把消息区整体撑高，真实滚动发生在页面而非 `#messages`；因此给 `#messages.scrollTop` 赋值在 Safari 中视觉上无效。
- 会话工作区改为 viewport 内受约束的 flex 布局：workspace 固定可视高度并隐藏外溢，content/session-detail 使用 `min-height:0`，session list 与 messages 成为明确滚动容器；移动端按 56px header 重新计算高度。
- 最新定位增加 `lastElementChild.scrollIntoView({ block: 'end' })` 作为 Safari 双保险；用户主动加载旧历史时仍保持阅读位置。
- 新增静态 CSS 契约及浏览器 helper 回归，前端资源版本升级为 `20261002-message6`。
- 全量验证：236 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。当前复审步骤未重新部署 message6。
- 手机实际交互待用户确认；未提交或 push。


## message6 部署验收（2026-10-02 19:57）

- 已部署 `/opt/app/aitools/sea-bridge-releases/web-message6-20261002-195715`，launchd 已运行此 release。
- `bun test`：236 pass / 0 fail；`bun run typecheck`、`bun run build`、`git diff --check` 通过。
- Tailscale IP 首页、message6 JS/CSS 均返回 200；未授权 status 返回 401；部署产物 SHA-256 与当前 dist 匹配。
- 本轮部署未修改 Tailscale 配置，未提交或 push；iPhone 内部滚动容器效果仍需设备侧确认。


## 提交前复核（2026-10-02）

- 修复 Tailnet HTTP 退出响应误加 Secure：Cookie 删除与签发均按 origin 的 HTTPS 协议判断。HTTP/HTTPS 回归修复前失败，修复后通过。服务端仍先撤销登录凭据。
- `bun run typecheck`、`bun test`（236 pass / 0 fail，1011 assertions）、`bun run build`、`git diff --check` 通过。
- 此退出 Cookie 清理补丁尚未重新部署；运行服务仍为此前 message6 release。


## message7 手机阅读空间优化（2026-10-02 20:24）

- 品牌栏/导航/会话栏压缩；输入框一行至三行，发送按钮并排；历史说明与加载较早控件置于消息滚动区顶部；卡片缩小留白。
- VisualViewport 约束手机已登录界面高度与 offsetTop；输入聚焦且检测到键盘缩短 viewport 时隐藏品牌/导航，保留会话返回和输入框；缩放时避免误判。
- 旧页前插按 scrollHeight 增量保持阅读锚点，最新内容在输入增高与 viewport 改变时按原阅读位置决定跟随。
- `bun run typecheck`、`bun test`（238 pass / 0 fail）、`bun run build`、`git diff --check` 通过。
- 浏览器合成消息预览：390×844 消息区 663px（约79%）；五行输入高度限92px；500px 键盘模式消息区404px、输入底部500px。截图：2026-10-02-mobile-message-space.png。此模拟不能替代真实 iPhone 键盘验收。
- 部署 `/opt/app/aitools/sea-bridge-releases/web-message7-20261002-202410`；IP 首页/JS/CSS 200，未授权 status 401，运行 release 与构建哈希匹配。未改 Tailnet 配置，未提交或 push 本轮改动。
- 本次部署也包含此前已提交的 HTTP logout Cookie 清理补丁。
## message8 断线与自动恢复（2026-10-02）

- 保留当前 Tailnet IP HTTP 入口，不修改 Tailscale Serve/Funnel；本轮只改善已加载页面的断线体验。
- 新增全屏连接状态面板：断线后保留导航/界面外壳，清空会话、消息、日志、设备等敏感渲染内容；文案统一为“服务暂不可达”，不把网络失败归因到 Shadowrocket/Tailscale 插件。只有服务端明确返回 401 才回到配对页。
- API 客户端增加 AbortController 超时：GET 8 秒、写请求 20 秒。空 5xx/代理异常归类为 transport unavailable；底层网络异常不直接展示浏览器/代理细节。
- 自动恢复使用 1/2/4/8/15/30 秒有界指数退避；“立即重试”、浏览器 online/pageshow/visibility 恢复可触发即时核查。隐藏页面时停止重试并关闭 SSE，重新可见后重新校验。
- 恢复门槛为双重验证：先重新读取 auth session 与全局脱敏 settings，再新建 SSE；只有 SSE open 后才解除 paused 并重新加载敏感内容。SSE 建连本身也有 8 秒客户端超时。
- 写请求在网络/超时边界失败时保留原 operationId 和“结果待确认”状态；恢复后查询 /api/operations/:id 进行核查，绝不自动重新 POST 原消息。创建对话框在断线时关闭，未提交草稿仍只保留在当前页面内存。
- 前端静态资源版本提升为 20261002-message8。新增回归覆盖：通用不可达文案、请求超时、敏感内容隐藏、1 秒首轮重连、待确认操作保留、恢复后核查而非重发。
- 全量验证：241 pass / 0 fail；bun run typecheck、bun run build、git diff --check 通过。本轮未部署 message8，未修改 Tailnet 配置。


## message8 部署验收（2026-10-02 20:48）

- 已部署 `/opt/app/aitools/sea-bridge-releases/web-message8-20261002-204738`，launchd 已运行此 release。
- `bun run typecheck`、`bun test`（241 pass / 0 fail）、`bun run build`、`git diff --check` 通过。
- Tailscale IP 首页、message8 JS/CSS 均返回 200；未授权 status 返回 401；部署产物 SHA-256 与当前 dist 匹配。
- 未修改 Tailscale Serve/Funnel、未提交或 push 本轮改动。未关闭真实手机隧道，iPhone 断线与恢复体验仍需设备侧验证。


## message8 提交前复核

- 修复超时只覆盖响应头的问题，计时器保留到正文读取结束；正文 AbortError 映射为明确超时。
- 恢复校验前后绑定同一 OPEN SSE，连接中途丢失或被替换时旧恢复结果不能解除 paused。新增两条失败回归后修复。
- 去掉新增测试 any，补充恢复辅助函数说明；`bun run typecheck`、`bun test`（243 pass / 0 fail）、`bun run build`、`git diff --check` 通过。
- 这些提交前补丁未重新部署，运行态仍为 web-message8-20261002-204738。
