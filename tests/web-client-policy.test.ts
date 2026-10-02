import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";

test("an in-flight sensitive response cannot repopulate the page after SSE disconnect", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  let resolveFetch: (response: Response) => void = () => { throw new Error("request not started"); };
  const pending = new Promise<Response>((resolve) => { resolveFetch = resolve; });
  const nodes = new Map<string, { textContent: string; replaceChildren: () => void }>();
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ state, api, clearSensitive })", {
    document: { cookie: "", getElementById(id: string) { let value = nodes.get(id); if (!value) { value = { textContent: "", replaceChildren() {} }; nodes.set(id, value); } return value; } },
    fetch: () => pending, URLSearchParams,
  }) as { state: { version: number; paused: boolean }; api: (path: string) => Promise<unknown>; clearSensitive: () => void };
  harness.state.version = 1; harness.state.paused = false;
  const response = harness.api("/api/sessions");
  harness.state.paused = true; harness.clearSensitive();
  resolveFetch(Response.json({ data: { items: [{ title: "private fixture" }] } }, { headers: { "X-Sea-Bridge-Settings-Version": "1" } }));
  await expect(response).rejects.toThrow("连接尚未重新确认设置");
});
