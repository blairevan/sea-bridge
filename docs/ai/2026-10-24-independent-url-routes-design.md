# Design Spec: 独立 URL 路由、默认 Tab 与路径记忆支持

- **Date**: 2026-10-24
- **Branch**: codex/independent-url-routes
- **Project**: sea-bridge
- **Status**: Approved
- **Issue Source**: 飞书文档「sea-bridge需求与记录」第 3 条 (Block ID: XlPhdMWuFoTI28xOjF7c3bmCnJb)

---

## 1. 目标与背景

当前 Sea-Bridge 控制台 Web 界面存在以下局限：
1. **URL 单一，缺乏路由直达能力**：服务端仅将 /、/app.js 等静态文件注册映射，直接在地址栏输入或刷新 /overview、/sessions、/records、/settings 会直接返回 404 not_found。
2. **前端无路由状态同步**：前端切换页面仅靠内部状态修改 DOM 的 hidden 属性，未与浏览器 History API 联动，无法通过浏览器前进/后退切换 Tab，且在各 Tab 间切换时地址栏不更新。
3. **缺乏默认页面与路径记忆**：首次进入系统只能固定进入概览页；无法在设置中指定期望的默认 Tab，也无法在访问根路径时记住并自动恢复上次浏览的页面。

本项目针对上述需求，提供：
- 独立的 URL 路由支持（/overview, /sessions, /records, /settings）；
- 设置页支持首次进入的默认 Tab 页配置；
- 记住上次访问的路径，根路径访问自动恢复至对应页面；
- 浏览器前进/后退原生历史导航支持。

---

## 2. 核心架构与方案

### 2.1 服务端路由白名单映射 (src/web/server.ts)
在服务端静态资源注册中：
- 页面路由白名单：PAGE_ROUTES = ["/overview", "/sessions", "/records", "/settings"];
- 将根路径 / 与四个页面路由均映射至同一份已渲染版本号的 index.html；
- 响应头沿用现有的严格安全策略：
  - Content-Type: text/html; charset=utf-8
  - Cache-Control: no-store
  - X-Content-Type-Options: nosniff
  - Content-Security-Policy: ...
- 非白名单路径且非 API 的请求保持 404 not_found，杜绝任意路径穿越或非法回退。

### 2.2 前端路由状态与 History API 联动 (src/web/public/app.js)
1. **页面合法性定义**：
   VALID_PAGES = ["overview", "sessions", "records", "settings"];
2. **路径解析与规范化**：
   pageFromPathname(pathname): 解析路径段（如 /sessions -> sessions），识别合法页面，忽略末尾斜杠与非白名单路径。
3. **showPage(page, { push = true, updateUrl = true } = {})**：
   - 切换当前激活的 Tab 视图与主导航高亮；
   - 若 updateUrl 为真且当前 location.pathname 不等于 "/" + page：
     - 若 push 为真：执行 history.pushState({ page }, "", "/" + page)；
     - 若 push 为假（如根路径自动替换或 popstate 恢复）：执行 history.replaceState({ page }, "", "/" + page)；
   - 调用持久化方法记录上次访问的页面。
4. **浏览器历史联动**：
   - 监听 window.addEventListener("popstate", (event) => ...)；
   - 从 event.state?.page 或当前 location.pathname 解析目标页面，调用 showPage(targetPage, { push: false })。

### 2.3 导航偏好与本地存储机制
按安全规约要求，前端偏好存取必须集中放置在 app.js 的偏好/缓存白名单区间内（位于 initializeTheme 与 operationUuid 之间）：
1. **存储键值规范**：
   - sea-default-page：字符串，取值范围 ["overview", "sessions", "records", "settings"]，缺省为 "overview"；
   - sea-remember-path：字符串布尔值 "true" | "false"，缺省为 true；
   - sea-last-page：字符串，最近一次成功打开的合法页面。
2. **页面启动与根路径解析流程**：
   - 第一优先级：若 location.pathname 直接匹配合法页面（如 /records），直接使用该页面；
   - 第二优先级（访问根路径 / 或非法页面）：
     - 若开启“记住上次路径”且存在有效的 sea-last-page，则选用该上次访问页面，并通过 replaceState 更新为该页面的独立 URL；
     - 否则（未开启或首次访问），选用配置的“默认 Tab 页”（缺省 overview），并通过 replaceState 更新为该页面的独立 URL。

### 2.3 设置页 UI 改造 (src/web/public/index.html)
在设置页增加「导航偏好」卡片：
- 包含「首次进入的默认 Tab 页」下拉选择框（default-page-select，选项：概览、会话、操作记录、设置）；
- 包含「记住上次访问的路径」切换复选框（remember-path）；
- 提示文案明确说明：访问根地址时将恢复至上次离开时的页面。此偏好仅保存在当前浏览器。

---

## 3. 边界与安全性设计

1. **白名单与防止目录遍历**：
   - 服务端严格只允许 ["/", "/overview", "/sessions", "/records", "/settings"];
   - 任何其他非静态资源路径均不会命中 HTML 映射。
2. **测试合规与 localStorage 限制**：
   - tests/web-static.test.ts 明确断言除了特定区间外，其余代码严禁出现 localStorage；
   - 新增的偏好存取函数全部严密存放在该许可区间内。
3. **XSS 与 HTML 注入防范**：
   - 不使用任何 innerHTML，纯使用 DOM API 构建与绑定事件。

---

## 4. 验证与测试规范

1. **静态服务单测 (tests/web-static.test.ts)**：
   - 验证 /overview, /sessions, /records, /settings 均返回 HTTP 200 与 index.html 内容；
   - 验证 /unknown 保持 404；
   - 验证 tests/web-static.test.ts 中的 DOM 与 localStorage 安全断言继续 100% 满足。
2. **前端逻辑与路由单测 (tests/web-message-ui.test.ts)**：
   - 验证合法与非法 pathname 解析；
   - 验证默认 Tab 页与路径记忆的读写与回退机制；
   - 验证根路径访问根据偏好解析出正确目标页并执行 replaceState。
3. **全量构建与回归**：
   - bun test 全部通过；
   - bun run typecheck 通过；
   - bun run build 构建通过。
