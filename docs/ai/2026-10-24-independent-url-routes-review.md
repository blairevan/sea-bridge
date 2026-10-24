# 独立 URL 路由、默认 Tab 与路径记忆代码审查报告

- **仓库及路径**: /opt/app/aitools/sea-bridge
- **基线 (Base ref/commit)**: main (780dc48)
- **候选树 (Tree SHA)**: 81586d7d57907e3bf762f127d2a653b96e02fea5
- **分支**: codex/independent-url-routes
- **审查日期**: 2026-10-24
- **审查结论**: PASS

---

## 1. 审查范围与改动文件

- src/web/server.ts: 静态资产注册增加 /overview, /sessions, /records, /settings 页面路由，与 / 一致返回版本化 shell；确保 HTML 页面路由始终使用 Cache-Control: no-store，非法路径保持 404。
- src/web/public/app.js:
  - 在合规偏好存储区间实现 pageFromPathname, readDefaultPagePreference, saveDefaultPagePreference, readRememberPathPreference, saveRememberPathPreference, readLastPage, saveLastPage, resolveInitialPage；
  - 改造 showPage(page, { push, updateUrl }) 联动 history.pushState / history.replaceState 与 saveLastPage；
  - 监听 popstate 事件实现原生前进/后退页面切换；
  - 启动阶段按当前路径 -> 记住路径 -> 默认 Tab 页优先级完成首次呈现；
  - 在 loadSettings 与初始化阶段双向同步导航偏好控件。
- src/web/public/index.html: 设置页增加「导航偏好」卡片，包含首次进入默认 Tab 下拉框 (default-page-select) 与记住上次访问路径复选框 (remember-path)。
- tests/web-static.test.ts: 扩展对 4 个独立路由与 404 边界的测试，断言新控件 ID 存在，断言 localStorage 安全区间未被污染。
- tests/web-routing.test.ts: 针对路径解析、偏好持久化、初始路由判定、URL 同步与历史联动的 8 项专项单元测试。

---

## 2. 审查项与核查结论

### 2.1 路由与安全性边界
- **白名单限制**: 服务端严格限制在 ["/", "/overview", "/sessions", "/records", "/settings"], 其余非 API 路径一律保持 404，无目录遍历风险。
- **缓存安全**: 明确排除页面路由参与长期不可变缓存，只有带版本参数的真实静态资源才使用 immutable 缓存。

### 2.2 存储与敏感信息防护
- **LocalStorage 审计**: 严格遵守 tests/web-static.test.ts 的区间限制，所有偏好仅位于安全白名单区间内。
- **无敏感泄漏**: 仅存取键名为 sea-default-page, sea-remember-path, sea-last-page，不包含任何个人身份、Token 或会话消息内容。
- **无 innerHTML**: DOM 操作均采用语义化 API，杜绝 XSS 注入点。

### 2.3 功能完整性与交互
- 4 个 Tab 具备独立的 URL 路由，刷新与直达均正常加载；
- 首次进入时按照设置的默认 Tab（缺省为概览）打开；
- 开启记住路径时，访问根路径可自动恢复至上次访问页面并以 replaceState 同步地址栏；
- 浏览器前进/后退切换 Tab 顺畅。

---

## 3. 门禁验证证据

- **全量测试**: bun test 492 pass / 0 fail / 2321 expect calls (覆盖 71 个测试文件)。
- **类型检查**: bun run typecheck 通过，0 错误。
- **JS 语法检查**: node --check src/web/public/app.js 通过。
- **差异检查**: git diff --check 通过，无多余空格与格式冲突。
- **构建测试**: bun run build 成功打包产物。

---

## 4. 审查结果

- **Critical**: 0
- **Warning**: 0
- **Suggestion**: 0
- **结论**: **PASS**
