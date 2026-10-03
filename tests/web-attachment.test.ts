import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { readCodexAttachment } from "../src/web/codex-attachment.ts";
import type { WebHistory } from "../src/web/sources/types.ts";

test("native images require the exact user record, image bytes and a confined path", async () => {
  const thread = randomUUID(); const root = `/tmp/codex-remote-attachments/${thread}`;
  await mkdir(root, { recursive: true });
  const bytes = Buffer.from([137,80,78,71,13,10,26,10]);
  /** Build a native envelope for the selected attachment. */
  const history = (path: string): WebHistory => ({ messages: [{ id: "rollout-1", role: "user", text: `# Files mentioned by the user:\n\n## image.png: ${path}\n\n## My request:\nPlease inspect.` }], cursor: null, completeUserHistory: false });
  try {
    await writeFile(`${root}/image.png`, bytes);
    const result = await readCodexAttachment(thread, "rollout-1", 0, history(`${root}/image.png`));
    expect(result.contentType).toBe("image/png"); expect(Buffer.from(result.bytes)).toEqual(bytes);
    await expect(readCodexAttachment(thread, "other", 0, history(`${root}/image.png`))).rejects.toThrow();
    await expect(readCodexAttachment(thread, "rollout-1", -1, history(`${root}/image.png`))).rejects.toThrow();
    await expect(readCodexAttachment(thread, "rollout-1", 1, history(`${root}/image.png`))).rejects.toThrow();
    await writeFile(`${root}/text.png`, "not an image");
    await expect(readCodexAttachment(thread, "rollout-1", 0, history(`${root}/text.png`))).rejects.toThrow();
    await symlink("/etc/hosts", `${root}/escape.png`);
    await expect(readCodexAttachment(thread, "rollout-1", 0, history(`${root}/escape.png`))).rejects.toThrow();
    const assistant = history(`${root}/image.png`); assistant.messages[0]!.role = "assistant";
    await expect(readCodexAttachment(thread, "rollout-1", 0, assistant)).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});
