/** Read-only live Host → isolated in-memory observer → fake Telegram acceptance probe. */
import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { DshWebHostClient } from "../../src/dsh/web-host-client.ts";
import { DshSessionObserver } from "../../src/dsh/session-observer.ts";
import { DshBridgeStore } from "../../src/state/dsh-bridge-store.ts";
import { StateDb } from "../../src/state/db.ts";

const client = new DshWebHostClient({
  socketPath: join(homedir(), ".dsh/run/sea-bridge.sock"),
  tokenPath: join(homedir(), ".dsh/run/sea-bridge.token"),
});
const sessions = await client.listSessions();
let candidate: { sessionId: string; cursor: number; eventSeq: number; turn: number } | null = null;
for (const session of sessions.slice(0, 30)) {
  const snapshot = await client.followSnapshot(session.sessionId);
  if (snapshot.cursor < 0 || snapshot.truncated) continue;
  const page = await client.pageHistory(session.sessionId, snapshot.cursor);
  const terminal = page.events.findLast((event) => event.type === "turn/end" && event.reasonKind === "completed");
  if (terminal && Number.isSafeInteger(terminal.turn) &&
    snapshot.cursor - terminal.seq <= 32 && !page.truncated) {
    candidate = { sessionId: session.sessionId, cursor: snapshot.cursor,
      eventSeq: terminal.seq, turn: terminal.turn! };
    break;
  }
}
if (!candidate) {
  process.stdout.write("in-memory observer acceptance: no recent verified completion; not asserted\n");
} else {
  const selected = candidate;
  const db = new StateDb(":memory:");
  try {
    const store = new DshBridgeStore(db);
    store.saveObserverState({ sessionId: selected.sessionId, cursor: selected.eventSeq - 1,
      contractFingerprint: "dsh-web-0.1.7-rc.2-metadata-v1", lastEventFingerprint: null });
    let messages = 0;
    const observer = new DshSessionObserver({
      listSessions: async () => (await client.listSessions()).filter((row) => row.sessionId === selected.sessionId),
      followSnapshot: (sessionId) => client.followSnapshot(sessionId),
      pageHistory: (sessionId, throughSeq, beforeSeq) => client.pageHistory(sessionId, throughSeq, beforeSeq),
      getTurnSummary: (sessionId, turn, throughSeq) => client.getTurnSummary(sessionId, turn, throughSeq),
    }, store, { sendMessage: async (chatId, text) => {
      assert.equal(chatId, "fake-chat");
      assert.ok(text.includes("dsh Web"));
      messages++;
      return { message_id: 1 };
    } }, "fake-chat");
    await observer.pollOnce();
    assert.ok(messages >= 1);
    assert.ok(store.getObserverState(selected.sessionId)?.cursor >= selected.eventSeq);
    assert.equal(store.findMessageLink("fake-chat", 1)?.sessionId, selected.sessionId);
    process.stdout.write(`in-memory observer acceptance passed: ${messages} fake Telegram notification(s); no real Telegram send\n`);
  } finally {
    db.close();
  }
}
