# dsh 连接器目录整理与交付

1. [x] 检查：feature/web-console 分支，提交身份与上一提交一致，无无关变更。
2. [x] 调整：正式插件迁移至 connectors/dsh，诊断与恢复工具迁移至 scripts/dsh；同步安装源、README 和历史文档链接。
3. [x] 审查：逐文件与迁移前 Git 内容比较；仅 probe-health 的跨目录导入发生变化。未新增依赖或改变宿主协议。内置语义审查未发现阻断问题。
4. [x] 验证：node --test connectors/dsh/index.test.mjs scripts/dsh/recover-metadata.test.mjs（12 通过）；bun test（345 通过）；bun run typecheck；bun run build；bash -n scripts/install-dsh-connector.sh scripts/dsh/run-health-poc.sh；bun run dsh-connector:check；git diff --check。
5. [x] 部署：创建私有备份和 v0.14.1 发布快照；重新加载应用 LaunchAgent。首次立即 bootstrap 遇到退出时序问题，恢复旧配置后分开执行 bootout/bootstrap 完成切换。
6. [ ] 提交并推送：用户已明确授权，发布核验完成后执行。

说明：本次目录调整不改变页面功能或版本号。已安装 dsh 插件内容与迁移后源码一致，无需重启 dsh 宿主。仓库未配置 lint/format 脚本；未新增工具依赖。真实登录与 iPhone 操作未重新验证。

运行核验：LaunchAgent state=running，启动路径为本次新发布快照；curl 本机/域名首页均 200，未认证会话均 401。Python urllib 域名请求曾返回 403，curl 验证通过，未将该客户端差异视为登录验收。
