import { connect } from "node:net";
import { loadWebConfig } from "../src/config.ts";
import { PASSWORD_OPTIONS, validPassword, validUsername } from "../src/web/password.ts";

/** Read from a real terminal and restore echo on every completion or interruption. */
function terminalLine(prompt: string, hidden: boolean): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.reject(new Error("terminal_required"));
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const wasRaw = process.stdin.isRaw;
    /** Release input listeners and restore the terminal before settling. */
    const finish = (error?: Error): void => {
      if (finished) return; finished = true;
      process.stdin.off("data", onData); process.stdin.off("end", onEnd); process.stdin.off("error", onError);
      process.stdin.setRawMode(wasRaw); process.stdin.pause(); process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    /** Fail closed if input ends before an explicit confirmation. */
    const onEnd = (): void => finish(new Error("terminal_closed"));
    /** Restore the terminal if the input stream fails. */
    const onError = (): void => finish(new Error("terminal_failed"));
    /** Consume bounded Unicode text without echoing password characters. */
    const onData = (chunk: string): void => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") { finish(); return; }
        if (char === "\u0003" || char === "\u0004") { finish(new Error("canceled")); return; }
        if (char === "\u007f" || char === "\b") {
          const points = Array.from(value); points.pop(); value = points.join("");
          if (!hidden) process.stdout.write("\b \b");
        } else if (!/[\u0000-\u001f]/.test(char)) {
          if (value.length + char.length > (hidden ? 256 : 64)) { finish(new Error("input_too_long")); return; }
          value += char; if (!hidden) process.stdout.write(char);
        }
      }
    };
    process.stdin.setEncoding("utf8"); process.stdin.setRawMode(true); process.stdin.resume();
    process.stdin.on("data", onData); process.stdin.once("end", onEnd); process.stdin.once("error", onError);
    process.stdout.write(prompt);
  });
}

/** Set or reset the administrator through the owner-private local socket. */
async function main(): Promise<void> {
  if (process.argv.length !== 3 || process.argv[2] !== "account") throw new Error("Usage: bun run web:account");
  const config = loadWebConfig();
  const username = await terminalLine("账号（3–64 位字母、数字、_、.、-）：", false);
  if (!validUsername(username)) throw new Error("username_invalid");
  const password = await terminalLine("密码（12–256 个字符，输入不显示）：", true);
  if (!validPassword(password)) throw new Error("password_invalid");
  const confirmation = await terminalLine("再次输入密码：", true);
  if (password !== confirmation) throw new Error("password_mismatch");
  const passwordHash = await Bun.password.hash(password, PASSWORD_OPTIONS);
  const response = await new Promise<string>((resolve, reject) => {
    const socket = connect(config.controlSocketPath); let text = "";
    socket.setTimeout(3000, () => socket.destroy(new Error("web_control_timeout")));
    socket.on("connect", () => socket.end(JSON.stringify({ op: "account.set", username, passwordHash }) + "\n"));
    socket.on("data", (chunk) => { text += chunk.toString(); if (text.length > 1024) socket.destroy(new Error("web_control_response_too_large")); });
    socket.on("end", () => resolve(text)); socket.on("error", reject);
  });
  const result: unknown = JSON.parse(response);
  if (typeof result !== "object" || result === null || !("updated" in result) || result.updated !== true) throw new Error("web_control_failed");
  process.stdout.write("账号已设置，所有旧登录已失效。请使用账号密码登录网页。\n");
}

main().catch(() => { process.stderr.write("账号未设置完成：请在 Mac 终端运行，检查输入、密码确认以及 Web 服务的本机控制 socket。\n"); process.exitCode = 1; });
