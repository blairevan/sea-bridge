# 会话与操作记录筛选折叠及移动端防横撑设计方案 (Design Specification)

- **Goal**: 满足飞书需求条目 4「折叠筛选区域」：
  1. 会话 Tab 页筛选区域默认折叠，在“新建”按钮左侧增加展开/折叠按钮；
  2. 操作记录 Tab 页筛选区域默认折叠，提供展开/折叠按钮；
  3. 彻底修复操作记录在移动端因长日志与双列网格导致的页面横向溢出（左右滑动）问题；
  4. 解释并防范移动端向下滑动方向与吸底联动的用户体验问题。
- **Scope**: src/web/public/index.html, src/web/public/app.css, src/web/public/app.js, tests/
- **Status**: Approved (一镜到底模式)

---

## 1. 结构与交互设计

### 1.1 会话 Tab 筛选折叠
- 在 `src/web/public/index.html` 的 `.session-list .section-heading` 内：
  ```html
  <div class="section-heading">
    <h2>会话</h2>
    <div class="session-heading-actions">
      <button id="toggle-session-filters" type="button" class="quiet session-filter-toggle">展开筛选</button>
      <button id="new-session">＋ 新建</button>
    </div>
  </div>
  ```
- 筛选区域容器包裹：
  将 `source-filter`、`creation-client-filter`、`activity-filter`、`session-search` 4 个控件及其标签包裹在 `<div id="session-filter-panel" class="session-filter-panel" hidden>` 中。
- 交互状态：
  - 默认状态：折叠（`#session-filter-panel` 带有 `hidden` 属性），按钮文案为「展开筛选」；
  - 点击按钮：切换 `hidden` 状态。展开时按钮文案变为「收起筛选」，折叠时恢复「展开筛选」；
  - 辅助功能：设置 `aria-expanded="false|true"` 与 `aria-controls="session-filter-panel"`；
  - 概览快捷联动：当从概览页点击“查看运行”或“查看待审批”跳转至会话时，自动调用 `expandSessionFilters()` 展开筛选面板，方便用户查看已选中的过滤条件。

### 1.2 操作记录 Tab 筛选折叠
- 在 `src/web/public/index.html` 的 `#records` 内：
  ```html
  <div class="section-heading">
    <h1>操作记录</h1>
    <button id="toggle-record-filters" type="button" class="quiet record-filter-toggle">展开筛选</button>
  </div>
  <p class="muted">桥接提交结果与诊断记录；不代表完整聊天历史。</p>
  <form id="record-filter" class="filters" hidden>...
  ```
- 交互状态：
  - 默认状态：折叠（`#record-filter` 带有 `hidden` 属性），按钮文案为「展开筛选」；
  - 点击按钮：切换 `hidden` 状态。展开时按钮文案变为「收起筛选」，折叠时恢复「展开筛选」；
  - 辅助功能：设置 `aria-expanded="false|true"` 与 `aria-controls="record-filter"`。

### 1.3 移动端防横撑与宽度修复 (Anti-Horizontal-Overflow)
- **日志自动换行**：
  为 `#log-items pre.record-row` 明确覆盖浏览器默认的 `white-space: pre`，设置：
  ```css
  #log-items pre.record-row {
    white-space: pre-wrap;
    word-break: break-all;
    overflow-wrap: anywhere;
    max-width: 100%;
  }
  ```
- **操作记录表单移动端弹性优化**：
  在 `@media(max-width:760px)` 中，确保 `#record-filter` 容器不超出屏幕宽度；针对 `input[type="datetime-local"]` 保证在窄屏下弹性伸缩或单列排版，设置 `min-width: 0`，彻底消除移动端左右滑动。

---

## 2. 架构与边界约束

1. **零外部新依赖**：纯 HTML/CSS/原生 DOM API 实现；
2. **安全与 XSS 防护**：无 `innerHTML`，文本使用 `textContent`，属性使用 `setAttribute`；
3. **既有自动化测试保护**：保留既有 ID（`source-filter`, `activity-filter`, `session-search`, `new-session`, `record-filter` 等），确保已有的 492 项测试完整通过；
4. **单测覆盖**：新增 `tests/web-filter-ui.test.ts` 验证展开/折叠状态切换、ARIA 属性及样式。

