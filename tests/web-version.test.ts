import { expect, test } from "bun:test";
import { APP_VERSION, renderVersionedShell } from "../src/web/version.ts";
import manifest from "../package.json";

test("shell version is supplied by the package manifest for display and asset URLs", () => {
  expect(APP_VERSION).toBe(manifest.version);
  const html = renderVersionedShell('<span>v__SEA_BRIDGE_VERSION__</span><script src="/app.js?v=__SEA_BRIDGE_VERSION__"></script>');
  expect(html).toContain(`v${manifest.version}`);
  expect(html).toContain(`/app.js?v=${manifest.version}`);
  expect(html).not.toContain("__SEA_BRIDGE_VERSION__");
});
