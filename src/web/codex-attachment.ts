import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";
import type { WebHistory } from "./sources/types.ts";

/** Read only a native user message's referenced image inside its own attachment directory. */
export async function readCodexAttachment(threadId: string, messageId: string, index: number, history: WebHistory): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId) || !Number.isSafeInteger(index) || index < 0 || index > 19) throw new Error("attachment_missing");
  const message = history.messages.find((item) => item.id === messageId && item.role === "user");
  if (!message?.text.startsWith("# Files mentioned by the user:")) throw new Error("attachment_missing");
  const header = message.text.split("## My request:")[0] ?? "";
  const paths = [...header.matchAll(/^## [^\n]+?:\s*(\/tmp\/codex-remote-attachments\/[^\n]+)$/gm)].map((match) => match[1]?.trim());
  const path = paths[index]; if (!path) throw new Error("attachment_missing");
  const root = await realpath(`/tmp/codex-remote-attachments/${threadId}`).catch(() => { throw new Error("attachment_missing"); });
  const actual = await realpath(path).catch(() => { throw new Error("attachment_missing"); });
  const diff = relative(root, actual);
  if (!diff || diff === ".." || diff.startsWith("../") || isAbsolute(diff)) throw new Error("attachment_missing");
  const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 10 * 1024 * 1024) throw new Error("attachment_missing");
    const buffer = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = await handle.read(buffer, size, buffer.length - size, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
    }
    if (size !== stat.size) throw new Error("attachment_missing");
    const bytes = buffer.subarray(0, size);
    const contentType = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()) ? "image/gif"
      : bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP" ? "image/webp" : null;
    if (!contentType) throw new Error("attachment_missing");
    return { bytes, contentType };
  } finally { await handle.close(); }
}
