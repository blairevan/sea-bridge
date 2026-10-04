# Web Console v0.13.4 提交检查

1. [x] 核对 `feature/web-console` 分支；fetch 后与远程无分歧，作者与上一提交一致。
2. [x] 明确范围：账号密码登录、会话元数据过滤、子代理过滤与标题兜底，以及测试和部署记录。
3. [x] 检查提交文件：没有本机配置、数据库、发布目录或凭据；敏感凭据特征扫描为零。
4. [x] 执行质量检查：`bun run typecheck`、`node --check src/web/public/app.js`、`bun test`、`bun run build`、`git diff --check` 全部通过；344 pass / 0 fail。
5. [x] 复核核心逻辑：凭据更新事务撤销旧会话，revision 阻止旧密码校验签发新会话；元数据过滤保留代码示例和原始历史，内部子代理只从列表排除。Cursor 只读审查超过三分钟未返回输出，已终止本次进程并采用技能允许的内置语义审查；未发现新的 Blocker/Warning。
6. 提交与推送：用户已明确授权；使用精确文件清单暂存，提交后校验远程分支 SHA 与本地 HEAD 一致。最终执行结果以 Git 记录为准。

项目没有 lint/format 脚本，本次没有新增依赖。既有远程登录共享限流桶的可用性风险与仅账号密码方案保持一致；本次检查不替代 iPhone 真机验收。
