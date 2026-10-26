# 会话与操作记录筛选折叠实施计划 (Implementation Plan)

- **Goal**: 实现会话与操作记录筛选区域默认折叠交互，修复移动端长日志横向溢出问题。
- **Architecture**: 原生 HTML 结构调整 + CSS 样式声明 + 原生 JS 事件绑定与 ARIA 状态同步。
- **Tech Stack**: Bun, TypeScript, Vanilla JS, HTML5, CSS3.
- **Spec**: [docs/ai/2026-10-26-foldable-filter-area-design.md](/opt/app/aitools/sea-bridge/docs/ai/2026-10-26-foldable-filter-area-design.md)

---

### Task 1: 编写筛选折叠与移动端防横撑测试 (TDD)

**Files:**
- Create: tests/web-filter-ui.test.ts
- Modify: tests/web-static.test.ts

- [ ] **Step 1: 编写针对折叠功能与样式的失败测试**
  在 tests/web-filter-ui.test.ts 中测试：
  1. 会话筛选容器 #session-filter-panel 初始存在且 hidden 为 true；
  2. 展开按钮 #toggle-session-filters 初始文案为「展开筛选」且位于 #new-session 之前；
  3. 操作记录表单 #record-filter 初始存在且 hidden 为 true；
  4. 操作记录展开按钮 #toggle-record-filters 初始文案为「展开筛选」；
  5. 点击切换展开/折叠及文案切换；
  6. 日志 pre 包含 white-space: pre-wrap 与 break-all 样式保证移动端不横撑。
- [ ] **Step 2: 运行测试观察 RED**
  执行 bun test tests/web-filter-ui.test.ts 确认测试预期失败。

---

### Task 2: HTML 结构与 CSS 样式改造

**Files:**
- Modify: src/web/public/index.html
- Modify: src/web/public/app.css

- [ ] **Step 1: 改造 index.html**
  - 在会话标题栏引入 button#toggle-session-filters；
  - 用 div#session-filter-panel 包裹会话筛选控件并设置 hidden；
  - 在操作记录标题栏引入 button#toggle-record-filters；
  - 为 form#record-filter 添加 hidden。
- [ ] **Step 2: 改造 app.css**
  - 添加 #session-filter-panel 的间距与过渡样式；
  - 添加 .session-heading-actions 弹性布局样式；
  - 针对 #log-items pre.record-row 添加 white-space: pre-wrap; word-break: break-all; max-width: 100%；
  - 优化移动端 #record-filter 的窄屏断点支持。

---

### Task 3: 前端交互逻辑绑定

**Files:**
- Modify: src/web/public/app.js

- [ ] **Step 1: 实现 toggleSessionFilters 与 toggleRecordFilters**
  切换 hidden 属性，更新按钮文案（展开筛选 / 收起筛选），同步 aria-expanded。
- [ ] **Step 2: 联动概览快捷跳转**
  当 openOverviewSessions 触发时，若筛选面板处于折叠状态，自动展开以便展示过滤条件。
- [ ] **Step 3: 运行测试观察 GREEN**
  执行 bun test tests/web-filter-ui.test.ts 确保通过。

---

### Task 4: 全量回归与代码审查

- [ ] **Step 1: 运行全量测试**
  执行 npm test 确保全量 490+ 项测试均通过。
- [ ] **Step 2: 执行代码审查并产出 review 报告**
  产出 docs/ai/2026-10-26-foldable-filter-area-review.md。

