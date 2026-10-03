# Queued input does not execute while the thread is unloaded

Prepared report; not posted externally.

## Environment

macOS; bundled Codex CLI 0.160.0; Desktop-owned app-server using default stdio. The shared daemon control socket is absent.

## Observed behavior

An existing thread had finished its preceding turn. A CLI queue command admitted a follow-up successfully, but the input stayed in native queue storage for approximately 15 minutes. A second input waited approximately 10 minutes. Both were later consumed in order. Native UserMessage.client_id records correlate each queue item to its subsequent turn. During the wait, the last native lifecycle event was task_complete, there was no bridge-owned pending approval, the Desktop app-server existed, and no app-server rollout handle was observed. The Desktop loaded-thread state was not directly observable.

## Isolated reproduction using the currently installed CLI

1. Use a separate CODEX_HOME and a loopback mock Responses provider.
2. Start app-server, create a thread, run a small turn and wait for completion.
3. Stop this isolated app-server and start another using the same isolated home, without resuming the thread.
4. Run codex queue --thread TEST_THREAD --message 'Reply OK.'. Exit status is 0.
5. After 12 seconds, native queue count is 1 and thread/loaded/list is empty.
6. Call thread/resume for TEST_THREAD on that same app-server. Do not issue turn/start or queue a second copy.
7. After 12 seconds, native queue count is 0 and turn/started is observed.

This proves unloaded-thread behavior in the isolated setup. It does not prove the exact reason Desktop unloaded or failed to load the production thread.

## Expected behavior and integration question

A successfully admitted follow-up should either trigger native loading/consumption or return an explicit outcome that distinguishes persisted-only input from an input routed to a live executor. Is there a supported authenticated way for an external integration to notify the existing stdio Desktop app-server without spawning a competing executor, focusing the UI, or sending a duplicate?

No production input text, credentials, user identities or raw rollouts are included.
