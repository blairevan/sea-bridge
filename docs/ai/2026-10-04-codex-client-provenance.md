# Codex 创建来源实施与验证

## 交付

- 依据用户审查后的设计：originator 精确白名单优先，非空未知不允许 source 覆盖；只有缺 originator 时才回退 cli/exec。不接受 vscode 创建类型。
- 原生元数据在 desktop 层立即归一化。四种固定 SQL projection 支持 source/originator 的全部缺列组合；每个 SQLite 读取连接重新探测可选列，运行期间新增/删除列都能生效，schema 竞态仅重试一次。必需可见性列缺失仍失败，不扩大可见范围。
- 平台保持 Codex/dsh；会话显示 Desktop/CLI/Sea-Bridge/Exec/未知创建来源。操作记录继续显示平台。
- 创建来源筛选在排序和 offset 分页前执行；现有 API 继续以 source 缺失/空值表示全部，source=all 仍返回 400。指定创建来源时服务端只读取 Codex，避免无关 dsh 故障误报 partial；source=dsh 携带筛选返回空，unknown 匹配旧缺字段数据。断线缓存复用相同语义，保留最多 300 条内存缓存并随隐私清理清空。
- 新建瞬时 pending 标记只存在当前浏览器；不新增 API 枚举、不伪造 Sea-Bridge 来源。当前筛选隐藏刚创建会话时，通过确切会话 ID 同步原生元数据，移除 pending 标记。
- fixture 位于 tests/fixtures/codex-provenance/target-mac.json，包含目标版本、列名和脱敏分组。自定义客户端名/线程来源被脱敏，结构化子代理 source 不收录原值。真实数据库仅只读采样，没有写入。

## 验证

精确执行命令：

```bash
bun run typecheck
bun test
node --check src/web/public/app.js
bun run build
git diff --check
```

全量 361 pass / 0 fail，1695 expectations，60 files。新增测试覆盖精确分类、空值/超长/异常值/未知值、四种 schema、运行期间可选列新增/删除、必需列缺失、Web 适配器投影、分页与非法参数、无关 dsh 故障隔离、paused 跨筛选缓存、直接会话导航清理旧筛选、过期响应、新建来源同步和旧消息状态显示回归。

使用 CodexThreadStore 对目标 Mac 数据库做只读投影：547 个普通会话；Desktop 108、CLI 23、Exec 3、Sea-Bridge 2、未知 411。数量只是该次快照，不作为测试固定期望。投影对象不包含原始 source/originator 字段。

## 自审

代码审查后额外修复：去掉跨连接的 schema 能力缓存，避免 Codex 升级新增可选列后必须重启 Sea-Bridge；创建来源筛选不再读取无关 dsh，避免误报 partial；恢复既有 `source=all` 非法契约；paused 概览纳入跨筛选 sessionCache 并按更新时间排序；从概览/继续会话直接进入详情时清空旧创建来源筛选。

逐项核查：平台身份没有改变；原生数据库无写入；发送授权与幂等键没有改变；未知非空 originator 仅暴露 evidence=originator，不暴露原值，也不会被 source 覆盖；源字段超长/类型异常不会触发错误回退；旧响应兼容；offset 的既有漂移限制保留；未新增依赖。

## 实施阶段验收边界（历史记录）

未 commit、push、部署或重启服务。正式上线的已登录页面及 Mac/iPhone 展示验收尚未进行。当前线上版本不包含本功能，不能把单元测试和只读数据库核验当作真实浏览器或设备验收。


## 部署补记

用户明确授权部署后，发布版本升至 v0.14.2，生成新发布快照，备份应用 plist 与 SQLite 后切换 LaunchAgent。部署前重新确认目标 Codex 版本和 schema 与 fixture 一致。

重新运行 bun run typecheck、bun test（361 pass / 0 fail，1695 expectations，60 files）、node --check src/web/public/app.js、bun run build、git diff --check 通过。版本变更后另跑 bun test tests/web-static.test.ts tests/web-build.test.ts（4 pass）并重新构建。

运行验证：LaunchAgent running，启动路径指向 v0.14.2 快照；本机及域名新版页面可达；远程首页/app.js 均 200，未认证会话 401。远程 HTML 含创建来源筛选，资源 query 为 v=0.14.2，脚本含来源标签及筛选实现。

本轮用户已授权提交与推送，本记录随功能代码提交；具体 SHA 与远程状态以 Git 记录为准。提交前再次运行完整验证，361 pass / 0 fail，类型检查、JS 语法检查、构建及 diff 检查通过。验收浏览器当前未登录，已打开控制台并请求用户登录；真实登录页面数据展示及 iPhone 验收尚未完成。此前“未部署”描述为实施阶段历史状态，以本节为当前状态。
