import { expect, test } from "bun:test";

test("session and record filter areas are collapsed by default in HTML with accessible toggle buttons", async () => {
  const html = await Bun.file("src/web/public/index.html").text();

  // Session filter toggle button must exist and precede new-session
  const toggleSessionIdx = html.indexOf('id="toggle-session-filters"');
  const newSessionIdx = html.indexOf('id="new-session"');
  expect(toggleSessionIdx).toBeGreaterThan(-1);
  expect(newSessionIdx).toBeGreaterThan(-1);
  expect(toggleSessionIdx).toBeLessThan(newSessionIdx);

  // Session filter panel must wrap filter controls and be hidden by default
  expect(html).toContain('id="session-filter-panel"');
  expect(html).toMatch(/<div[^>]*id="session-filter-panel"[^>]*hidden/);
  const panelIdx = html.indexOf('id="session-filter-panel"');
  const sourceFilterIdx = html.indexOf('id="source-filter"');
  const searchFilterIdx = html.indexOf('id="session-search"');
  expect(panelIdx).toBeLessThan(sourceFilterIdx);
  expect(panelIdx).toBeLessThan(searchFilterIdx);

  // Record filter toggle button must exist and record-filter must be hidden by default
  expect(html).toContain('id="toggle-record-filters"');
  expect(html).toMatch(/<form[^>]*id="record-filter"[^>]*hidden/);
});

test("CSS rules wrap long log lines and format filter toggles to prevent mobile horizontal overflow", async () => {
  const css = await Bun.file("src/web/public/app.css").text();
  expect(css).toMatch(/#log-items\s+pre\.record-row[^{]*\{[^}]*white-space\s*:\s*pre-wrap/);
  expect(css).toMatch(/#log-items\s+pre\.record-row[^{]*\{[^}]*word-break\s*:\s*break-all/);
  expect(css).toContain(".session-filter-toggle");
});

test("app.js toggles session and record filter panels and updates button labels and aria attributes", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  expect(script).toContain("toggleSessionFilters");
  expect(script).toContain("toggleRecordFilters");
  expect(script).toContain("展开筛选");
  expect(script).toContain("收起筛选");
});

