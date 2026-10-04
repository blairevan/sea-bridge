# Codex 会话创建来源识别设计

日期：2026-10-04。状态：设计已审查，用户已批准继续实施；实施进展见同日期计划与交付记录。

## 1. 问题与目标

Sea-Bridge 当前只有 codex/dsh 两个执行适配器。Codex 会话页面直接展示内部标识，不能分辨 Desktop、CLI 或 Sea-Bridge 创建的会话。统一改成 Codex Desktop 会造成误标。

目标是准确展示会话创建来源，并保留现有路由、发送能力、会话身份及历史记录。来源不明时明确降级。创建来源不代表现在的执行客户端，也不决定会话是否可以发送消息。

不包含：新增 CLI 执行适配器、自动切换执行器、改写 Codex 原生元数据、改变权限或数据库历史、大规模前端重构。

## 2. 已核验证据

- src/desktop/codex-thread-store.ts 读取 threads 表，但没有投影 source/originator。
- src/web/sources/codex.ts 将所有会话的适配器 source 固定为 codex；该字段承担路由语义。
- src/web/sources/types.ts 的 WebSession 没有创建客户端信息。
- 本机 state_5.sqlite 的 threads 表存在 source、originator、thread_source。
- 只读核验得到的非归档普通会话组合包括：vscode + Codex Desktop、vscode + codex-tui、vscode + sea-bridge、vscode + 空 originator，以及 cli/exec + 空 originator。由此可知 vscode 不能单独证明 Desktop 或 VS Code。
- Sea-Bridge App Server 初始化 clientInfo.name 为 sea-bridge，可作为创建来源的识别线索。

官方协议将 originator 定义为创建时来源，与当前客户端/执行器独立；source 则是 SessionSource：
https://github.com/openai/codex/blob/main/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs

上游已有真实案例证明不能用 source=vscode 推断具体客户端：Codex TUI 在部分版本会记录为 source=vscode、originator=codex-tui；第三方 app-server 也可能保留自己的 originator 而 source 仍为 vscode：
https://github.com/openai/codex/issues/48400
https://github.com/openai/codex/issues/23442

Codex Exec 上游当前明确使用 codex_exec 作为 originator，可作为 exec 的精确白名单证据：
https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs

协议/本机版本可能演进；本机已验证值仍是本次生产映射的首要依据，上游 main 只用于证明字段语义和补充精确白名单，不把 main 当作目标机版本合同。实施前必须在目标 Mac 重新导出一次脱敏的 source/originator/thread_source 组合及 Codex 版本，作为验收 fixture。

## 3. 方案比较

| 方案 | 优点 | 问题 | 结论 |
| --- | --- | --- | --- |
| 所有 codex 改名 Desktop | 最简单 | CLI、第三方客户端会误标 | 不采用 |
| 拆成 codex-cli/codex-desktop 路由 | 看起来分得清 | 把创建客户端当执行器；需改接口、状态及幂等键，当前没有独立能力支撑 | 不采用 |
| 保留平台路由，增加创建来源元数据 | 兼容、可追溯、未知可降级 | 需补齐读模型、接口、展示和测试 | 推荐 |

## 4. 数据模型

WebSession.source 保持 codex/dsh，含义为执行平台。新增可选 creationClient 对象，旧接口消费者可忽略，旧响应可缺失。

第一阶段只暴露已能可靠分类的值，不为尚无可靠证据的 VS Code 预留可被 API 消费的枚举值：

| 字段 | 类型/值 | 说明 |
| --- | --- | --- |
| kind | desktop / cli / sea_bridge / exec / unknown | 归一化的创建客户端 |
| evidence | originator / source / none | 本次分类依据；source 指原生 threads.source |

没有新建 Sea-Bridge 数据表或历史回填要求；创建来源随原生只读元数据重新投影。dsh 默认不提供该对象。缺失对象和 unknown 都按未知来源展示。

原始 source/originator 只允许停留在 desktop 读取/分类边界，不向网页、操作记录或普通日志透传任意字符串。自定义 originator 可能含私有客户端名称；即使分类为 unknown，也不得把原值写入公共日志或错误响应。这里的来源只用于展示与筛选，不是身份认证、授权、执行器选择或路由证据。

## 5. 分类规则

采用纯函数分类，保持原始字段不变。字符串只做 trim 和长度上限校验，随后进行大小写敏感的精确匹配；不使用 contains、startsWith、正则猜测或把未知字符串规范化成已知客户端。超过上限、类型异常均视为缺乏可信证据并安全降级为 unknown。

优先级：

1. 原生 thread_source 为 subagent，或现有代码已经识别为内部子代理的记录，继续按现有子代理排除规则处理；本次不扩大普通会话范围，也不改变子代理可见性。
2. originator 非空时只看精确白名单：Codex Desktop → desktop；codex-tui → cli；sea-bridge → sea_bridge；codex_exec → exec。
3. originator 非空但不在白名单 → unknown，evidence 仍记为 originator，但不透传原始值。此时即使 source=cli/exec/vscode，也不得覆盖未知 originator，避免把第三方 app-server 或未来客户端误标成官方客户端。
4. 仅当 originator 为空时才使用 source 做保守回退：source=cli → cli，source=exec → exec，其余 → unknown。
5. source=vscode 或任何其他未明确允许的 source 值单独出现时一律 unknown。第一阶段没有 VS Code 分类，因为 vscode 已被证明是宽泛且会跨 Desktop、TUI、第三方 app-server 出现的 source 值。

已知 originator 与宽泛 source 不一致时，以 originator 描述创建客户端。例如 codex-tui + vscode 仍显示 Codex CLI。该标签不是当前执行方式。

Sea-Bridge 新建会话也必须等原生元数据投影后才显示 Sea-Bridge 创建；前端不得仅因为“本次请求由 Sea-Bridge 发起”就在本地伪造持久 provenance。刚创建且尚未同步到 threads 时可显示“创建来源待同步”，刷新后以原生记录为准。“待同步”只是当前浏览器在刚完成 create 后的瞬时展示状态，不进入 creationClient 枚举、不进入 API 筛选值、也不持久化。

## 6. 读取、兼容与性能

优先在原有 SQL 查询中投影 source/originator，并在 desktop 层立即归一化为 creationClient；Web 层不接触原始 originator。SQLite 在列不存在时会在 prepare 阶段失败，因此兼容逻辑必须使用固定 SQL profile：先通过 PRAGMA table_info(threads) 分别识别 source、originator 是否存在，再覆盖“都有 / 仅 source / 仅 originator / 都没有”四种固定查询组合；缺哪一列就用 NULL AS 对应列。不得把列名、请求参数或数据库内容拼进 SQL。

这里不引入“按 inode/mtime 识别数据库身份”的复杂缓存，也不长期缓存可选列能力。每次新建 SQLite 读取连接时重新执行一次轻量 PRAGMA 探测，保证运行期间数据库替换或 Codex 升级新增 source/originator 后无需重启即可生效；若 schema 恰好在 PRAGMA 与查询 prepare 之间变化，只重新探测并重试一次。重试后仍失败则沿用 source_unavailable。分类结果为 unknown 本身不是读取失败，不应让 partial 变为 true。

现有 thread_source 子代理排除逻辑保持原样；这次兼容探测只为新增的 source/originator 服务，不顺带重写普通会话判定。如果目标版本连现有必需列都缺失，按来源不可用处理并通过版本 Gate 阻止部署，而不是静默扩大返回范围。

第一阶段不增加逐会话 rollout 文件读取。本机已发现可用数据库字段，缺元数据显示未知，比扫描所有会话文件更安全简单。如果后续确有补读需求，再单独设计受限路径、大小、缓存和失效机制，不随本次实现加入。

CodexThreadReader/CodexThread 的测试替身只增加可选、已归一化的 creationClient 字段；旧替身无需提供。不要向 Codex 数据库写入分类结果，也不要在 Sea-Bridge 数据库持久化一份会漂移的 provenance 副本。

## 7. 页面与筛选

平台/执行来源下拉框仍是 全部 / Codex / dsh；新建会话也仍选 Codex / dsh，不提供虚假的 CLI/Desktop 执行选项。上一轮把 codex 全量显示成“Codex Desktop”的未提交改动必须撤销或改写，平台标签统一恢复为 Codex；Desktop 只出现在每个会话自己的创建来源中。

会话列表、详情、概览和会话建议通过同一个显示函数生成标签：

| 创建来源 | 标签示例 |
| --- | --- |
| desktop | Codex · Desktop 创建 · 空闲 |
| cli | Codex · CLI 创建 · 执行中 |
| sea_bridge | Codex · Sea-Bridge 创建 · 空闲 |
| exec | Codex · Exec 创建 · 状态未知 |
| unknown 或缺字段 | Codex · 创建来源未知 · 空闲 |
| 刚创建、尚未同步原生元数据 | Codex · 创建来源待同步 · 执行中/状态未知 |
| dsh | dsh · 空闲 |

详情页明确字段名为“创建来源”。“打开 Mac”按钮仍受平台及实际能力约束；能打开 Desktop 不证明该会话由 Desktop 创建。

会话列表新增“创建来源”筛选：全部 / Desktop / CLI / Sea-Bridge / Exec / 未知。当执行来源选择 dsh 时隐藏并清空该筛选；执行来源为“全部”且指定创建来源时，只返回匹配的 Codex 会话并排除 dsh。来源筛选不改变新建会话的平台选择。页面断线进入 paused 状态时，本地缓存筛选必须复用同一语义，不能在线时过滤正确、离线时又把 dsh 或其他创建来源混回来。

GET /api/sessions 新增可选 creationClient 参数，第一阶段只允许 desktop / cli / sea_bridge / exec / unknown；非法值返回 400。现有 API 以 source 缺失或空值表示“全部”，不新增 source=all 别名。指定 creationClient 时读取范围直接收窄到 Codex，避免无关的 dsh 故障把结果误标为 partial；source=dsh 且仍携带 creationClient 时结果为空，服务端不能悄悄忽略该参数。creationClient=unknown 必须同时匹配显式 kind=unknown 和 creationClient 缺失的旧响应/旧 schema 会话，确保降级语义一致。

筛选顺序固定为：聚合来源 → 标题/sessionId/状态筛选 → creationClient 筛选 → updatedAt 排序 → offset/cursor 分页。这样能保证创建来源筛选发生在分页前；但当前 cursor 本质仍是 offset，会话在两次请求之间更新或插入时仍可能发生既有的翻页漂移，本功能不宣称提供快照级稳定分页，也不顺带重构 cursor。partial 继续只表示某个来源读取失败，不表示分类未知。不要为了未来 VS Code 支持提前接受 vscode 参数；等有可验证的精确 originator 后再扩枚举。

操作记录保持平台展示 Codex/dsh；不将历史执行记录改名 Desktop。会话建议可显示创建来源，但记录查询仍使用 source + sessionId，不以标签作为身份。

## 8. 执行与提交语义

详情保留执行状态及排队状态。创建来源只描述会话的起点。

第一阶段不新增“当前执行客户端”标签。现有 running/idle 和 native queue 证据不足以证明当前执行器是 Desktop 或 CLI。也不把“已入队”描述为 Desktop 已执行。

将来需要显示提交通道时，应针对具体操作记录真实调用路径，标明“提交通道”而非“执行客户端”；只有存在与当前 turn 绑定的运行证据，才考虑显示实际执行器。

## 9. 影响文件与边界

- src/desktop/codex-thread-store.ts：兼容字段读取。
- src/desktop/：增加小型纯函数分类模块，名称在实施计划确定。
- src/web/sources/types.ts、src/web/sources/codex.ts：传递归一化来源对象。
- src/web/http.ts：来源筛选及分页顺序。
- src/web/public/app.js、index.html：统一显示与列表筛选。
- tests/：分类、读库兼容、接口筛选、页面回归。

不重命名持久化 source，不更改 API 路由、幂等身份、发送权限和模型目录。

## 10. 验收标准

1. Codex Desktop + vscode 显示 Desktop 创建；codex-tui + vscode 显示 CLI 创建。
2. sea-bridge + vscode 显示 Sea-Bridge 创建；codex_exec + exec 显示 Exec 创建；vscode + 空 originator 显示未知。
3. 未知非空 originator 即使搭配 source=cli/exec/vscode 也保持 unknown；不按模糊文本分类，不被 source 覆盖。
4. originator 为空时，cli/exec 才按明确 source 回退；source=vscode 或其他未允许 source 单独存在仍为 unknown；子代理仍排除。
5. source/originator 缺列、空值、超长值、异常类型不崩溃；新增列缺失只降级 provenance，不把 Codex 整体判为不可用。
6. 改名不影响已有会话发送、排队状态、打开 Mac、操作记录和会话身份；平台选择和操作记录继续显示 Codex/dsh。
7. 列表/详情/概览/建议显示一致；刚创建但原生 metadata 尚未可见时显示“待同步”，不得前端伪造 Sea-Bridge provenance。
8. 创建来源筛选在分页前生效；覆盖多页结果、未指定 source + creationClient、source=dsh + creationClient 返回空、无关 dsh 故障不产生 partial、unknown 匹配缺字段、UI 切到 dsh 自动清空筛选、paused 本地缓存、非法参数和旧响应；source=all 仍按既有契约返回 400；测试不得把既有 offset cursor 描述成快照级稳定分页。
9. 第一阶段不接受 vscode creationClient，不增加 rollout 扫描、新依赖或数据库写入。
10. 类型检查、相关单测、全量测试、JS 语法检查、构建和 diff 检查通过。
11. 实施前保存目标 Mac 的脱敏 provenance fixture（Codex 版本、schema 列集合、source/originator/thread_source 组合）；上线后在已登录页面核验真实 Desktop、CLI、Sea-Bridge、Exec 和未知样本，Mac/手机展示与后端数据一致。未做登录及设备验收不得称完整上线验证。

## 11. 实施顺序与回滚

1. 先把上一轮未提交的全量“Codex Desktop”改名改回平台标签 Codex；现有四个未提交文件不得单独发布，也不要在它们上继续堆叠错误的平台语义。
2. 在目标 Mac 采集脱敏 provenance fixture，冻结本轮白名单；若真实值与本文不同，先修订分类表再写实现。
3. 实现纯函数分类及兼容读库，让原始 originator/source 在 desktop 层完成归一化，再传递 API 元数据。
4. 实现页面统一显示、创建来源筛选以及 paused 本地缓存的同语义筛选，更新测试。
5. 审查、测试、登录页面验收；用户授权后提交、推送和部署。

部署前备份发布快照和应用 plist。回滚使用旧发布目录；不需要数据回滚或修改 Codex 原生数据库。旧前端忽略新增元数据仍正常工作，新前端遇到旧响应显示未知。

## 12. 本轮交付边界

设计已获用户继续实施授权。前一轮全量 Desktop 改名已纠正，并按本设计实现；验证结果和未完成的部署/设备验收边界见实施计划及交付记录。设计审批不自动代表已部署或已提交。
