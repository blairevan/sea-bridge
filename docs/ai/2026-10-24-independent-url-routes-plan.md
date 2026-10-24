# 独立 URL 路由、默认 Tab 与路径记忆实施计划 (Implementation Plan)

- **Goal**: 为 Sea-Bridge Web 控制台提供概览、会话、操作记录、设置 4 个 Tab 的独立 URL 路由，支持设置首次进入默认 Tab，并支持记住上次访问路径。
- **Architecture**: 服务端为 4 个页面路由注册安全映射；前端通过 History API（pushState/replaceState/popstate）与 URL 联动；在安全白名单区间持久化本地偏好与上次路径。
- **Tech Stack**: Bun, TypeScript, Vanilla JS, HTML/CSS, Web Storage API, History API
- **Spec**: [docs/ai/2026-10-24-independent-url-routes-design.md](/opt/app/aitools/sea-bridge/docs/ai/2026-10-24-independent-url-routes-design.md)

---

### Task 1: 服务端独立 URL 路由映射与单测验证

**Files:**
- Modify: src/web/server.ts
- Modify: tests/web-static.test.ts

- [ ] **Step 1: 编写服务端路由的失败测试**
  在 tests/web-static.test.ts 中增加对 /overview, /sessions, /records, /settings 的 GET 校验，预期 200 并返回包含版本号的 HTML，非法路由返回 404。
- [ ] **Step 2: 改造 src/web/server.ts**
  将 PAGE_ROUTES 中的 /overview, /sessions, /records, /settings 注册到静态资产映射中，与 / 一致返回已渲染版本号的 index.html。
- [ ] **Step 3: 运行静态测试集确认通过**
  执行 bun test tests/web-static.test.ts 确保通过。

---

### Task 2: 前端导航偏好存取与路由解析模块

**Files:**
- Modify: src/web/public/app.js
- Modify: tests/web-message-ui.test.ts

- [ ] **Step 1: 编写偏好存取与路径解析的单测**
  在 tests/web-message-ui.test.ts 中添加对 pageFromPathname, readDefaultPagePreference, saveDefaultPagePreference, readRememberPathPreference, saveRememberPathPreference, readLastPage, saveLastPage, resolveInitialPage 的单元测试。
- [ ] **Step 2: 在 app.js 安全区间实现偏好与解析逻辑**
  在 app.js 的 themeStart 与 themeEnd 之间添加偏好存取函数，确保不破坏 tests/web-static.test.ts 的 localStorage 范围检测。
- [ ] **Step 3: 改造 showPage 与 popstate 事件监听**
  支持 URL 同步（pushState / replaceState），更新上次路径，并监听 window 的 popstate 事件处理原生前进后退。
- [ ] **Step 4: 运行前端单测确保通过**
  执行 bun test tests/web-message-ui.test.ts 确保通过。

---

### Task 3: 设置页 UI 增加导航偏好卡片与初始化绑定

**Files:**
- Modify: src/web/public/index.html
- Modify: src/web/public/app.js
- Modify: tests/web-static.test.ts

- [ ] **Step 1: 在 index.html 设置页中增加导航偏好卡片**
  增加 default-page-select 与 remember-path 控件，遵守现有语义化与样式规范。
- [ ] **Step 2: 在 app.js 中完成初始化赋值与 change 事件监听**
  在 loadSettings 与启动阶段同步当前偏好，并在用户修改时实时保存。
- [ ] **Step 3: 更新启动初始化页面解析链路**
  在 checkInitialLogin / startup 阶段按优先级（当前路径 -> 上次路径 -> 默认页）呈现首屏。

---

### Task 4: 全量质量门禁与回归验证

- [ ] **Step 1: 全量单测运行**
  执行 bun test 确保 100% 测试通过。
- [ ] **Step 2: 类型检查与语法检查**
  执行 bun run typecheck 与 node --check src/web/public/app.js。
- [ ] **Step 3: 构建产物验证**
  执行 bun run build 并在临时目录验证打包无误。
- [ ] **Step 4: git diff 审查**
  审查所有修改，确保无无关代码或敏感信息泄露。
