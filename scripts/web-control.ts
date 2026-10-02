import { connect } from "node:net";
import { loadWebConfig } from "../src/config.ts";

/** Request a one-time code from the local private socket, with bounded output. */
async function main(): Promise<void> {
  if (process.argv[2] !== "pair") throw new Error("Usage: bun run web:pair");
  const config = loadWebConfig();
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(config.controlSocketPath); let text = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("web_control_timeout")));
    socket.on("connect", () => socket.end('{"op":"pair.create"}\n'));
    socket.on("data", (chunk) => { text += chunk.toString(); if (text.length > 1024) socket.destroy(new Error("web_control_response_too_large")); });
    socket.on("end", () => resolve(text)); socket.on("error", reject);
  });
  const result: unknown = JSON.parse(response);
  if (typeof result !== "object" || result === null) throw new Error("web_control_invalid_response");
  const row = result as Record<string, unknown>;
  if (typeof row.code !== "string" || !/^\d{8}$/.test(row.code) || typeof row.expiresAt !== "number") throw new Error("web_control_invalid_response");
  process.stdout.write(`配对码：${row.code}\n有效期至：${new Date(row.expiresAt).toLocaleString("zh-CN")}\n`);
}

main().catch(() => { process.stderr.write("无法生成配对码，请检查 Web 服务及本机控制 socket。\n"); process.exitCode = 1; });
