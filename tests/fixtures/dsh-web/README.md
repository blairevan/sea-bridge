# dsh Web Host Fixtures

Verified dsh CLI / Web Host version: `0.1.7-rc.2`.

`read-contract.json` contains synthetic shapes for the private Unix-socket contract. Identifiers, titles, and assistant text are invented. Tokens, workspace paths, cwd, browser cookies, launch tokens, credentials, reasoning, tool arguments, and private user paths must never enter fixtures.

The tracked Sea-Bridge connector is protocol `1`, runtime version `0.4.0`. General history operations (`history.follow`, `history.followWindow`, `history.page`) remain metadata-only. `sessions.list` may additionally expose only the durable client-visible title projection. `turn.summary` is the single content-bearing read operation: for an exact `sessionId + turn + turn/end seq`, it scans backward with bounded pages and returns only the latest non-empty committed `assistant/message` text blocks joined in order. Reasoning, tool-call arguments, images/files, arbitrary event data, cwd, and other projections never cross that operation.

Read operations are `health`, `projects.list`, `sessions.list`, `history.follow`, `history.followWindow`, `history.page`, `turn.summary`, and `models.catalog`. The client fails closed on incomplete bounded listings, malformed terminal/summary contracts, and connector version mismatch.

The full bridge additionally implements the exact dsh `0.1.7-rc.2` Session Controller write contracts verified from the tagged upstream source:

- `session.create` calls `sessionController.create({ workspaceId, sessionId })`. Sea-Bridge mints a stable explicit session ID so Host create/adopt semantics are idempotent.
- `prompt.submit` calls `sessionController.prompt({ requestId, sessionId, mode: "queue", content: [{ type: "text", text }] }, signal)`. The stable `requestId` is the Host-supported prompt idempotency key.
- `session.selectModel` calls `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`.

Write fixture bodies are synthetic rather than copied from live sessions. Busy/writer-held, proven rejection, and ambiguous delivery are tested as typed outcomes. Unknown or timed-out writes are never automatically replayed.

Important dsh `0.1.7-rc.2` behavior: `selectModel` installs the Session-local next-request model selection and also persists that selection as the Host default asynchronously. The Telegram model UI therefore warns that choosing a model for a Sea-Bridge-created session can affect the default inherited by later Web sessions.
