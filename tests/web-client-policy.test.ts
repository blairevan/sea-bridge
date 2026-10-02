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

test("empty proxy responses surface HTTP evidence instead of a browser JSON exception", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const boundary = script.indexOf('\ndocument.querySelectorAll("nav button").forEach((button) => { button.onclick');
  if (boundary < 0) throw new Error("UI fixture boundary missing");
  const harness = runInNewContext(script.slice(0, boundary) + "\n({ api })", {
    document: { cookie: "" }, fetch: async () => new Response("", { status: 503 }), URLSearchParams,
  }) as { api: (path: string, method: string, body: unknown) => Promise<unknown> };
  await expect(harness.api("/api/auth/pair", "POST", { code: "fixture" })).rejects.toThrow("HTTP 503");
});

test("mobile pairing explicitly validates digits and always releases its button", async () => {
  const script = await Bun.file("src/web/public/app.js").text();
  const start = script.indexOf("async function pairDevice()");
  const end = script.indexOf('\nel("pair-submit").onclick', start);
  if (start < 0 || end < 0) throw new Error("pair handler missing");
  const nodes: Record<string, { value: string; disabled: boolean }> = { "pair-code": { value: "bad", disabled: false }, "pair-submit": { value: "", disabled: false }, "device-name": { value: "", disabled: false } };
  let calls = 0; const notices: string[] = [];
  const pair = runInNewContext(script.slice(start, end) + "\npairDevice", { el: (id: string) => nodes[id], notice: (text: string) => notices.push(text), api: async () => { calls++; throw new Error("fixture transport failure"); } }) as () => Promise<void>;
  await pair(); expect(calls).toBe(0); expect(notices).toContain("请输入 8 位数字配对码");
  nodes["pair-code"]!.value = " 12345678 ";
  await expect(pair()).rejects.toThrow("fixture transport failure");
  expect(calls).toBe(1); expect(notices).toContain("正在配对…"); expect(nodes["pair-submit"]!.disabled).toBe(false);
});
