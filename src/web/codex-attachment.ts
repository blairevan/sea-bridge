import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { relative, isAbsolute, basename } from "node:path";
import { tmpdir } from "node:os";
import type { WebHistory } from "./sources/types.ts";

function sniffImageContentType(bytes: Buffer | Uint8Array): string | null {
  if (bytes.length < 8) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
    : buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
    : ["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString()) ? "image/gif"
    : Buffer.from(bytes.subarray(0, 4)).toString() === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString() === "WEBP" ? "image/webp" : null;
}

/** Read only a native user message's referenced image inside its own attachment directory. */
export async function readCodexAttachment(threadId: string, messageId: string, index: number, history: WebHistory): Promise<{ bytes: Uint8Array; contentType: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(threadId) || !Number.isSafeInteger(index) || index < 0 || index > 19) throw new Error("attachment_missing");
  const message = history.messages.find((item) => item.id === messageId && item.role === "user");
  const messageText = message?.text.trimStart() ?? "";
  if (!message || !messageText.startsWith("# Files mentioned by the user:")) throw new Error("attachment_missing");
  if (message.images?.[index]) {
    const inline = message.images[index];
    const buffer = Buffer.from(inline.base64, "base64");
    if (buffer.length > 10 * 1024 * 1024) throw new Error("attachment_missing");
    const contentType = sniffImageContentType(buffer) ?? inline.contentType;
    if (!contentType) throw new Error("attachment_missing");
    return { bytes: new Uint8Array(buffer), contentType };
  }
  const header = messageText.split("## My request:")[0] ?? "";
  const paths = [...header.matchAll(/^## [^\n]+?:\s*([^\n]+)$/gm)].map((match) => match[1]?.trim());
  const path = paths[index]; if (!path) throw new Error("attachment_missing");
  const root = await realpath(`/tmp/codex-remote-attachments/${threadId}`).catch(() => null);
  const actual = await realpath(path).catch(() => { throw new Error("attachment_missing"); });
  let isAllowed = false;
  if (root) {
    const diff = relative(root, actual);
    if (diff && diff !== ".." && !diff.startsWith("../") && !isAbsolute(diff)) isAllowed = true;
  }
  if (!isAllowed) {
    const filename = basename(actual);
    if (/^codex-clipboard-[0-9a-fA-F-]+\.(png|jpe?g|gif|webp)$/i.test(filename)) {
      const allowedDirs = [tmpdir(), "/tmp", "/var/folders", "/private/var/folders"];
      for (const dir of allowedDirs) {
        const resolvedDir = await realpath(dir).catch(() => null);
        if (resolvedDir && !relative(resolvedDir, actual).startsWith("..")) {
          isAllowed = true;
          break;
        }
      }
    }
  }
  if (!isAllowed) throw new Error("attachment_missing");
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
    const contentType = sniffImageContentType(bytes);
    if (!contentType) throw new Error("attachment_missing");
    return { bytes, contentType };
  } finally { await handle.close(); }
}
