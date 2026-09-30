# dsh Web Host Fixtures

Verified dsh CLI / Web Host version: `0.1.7-rc.2`.

`read-contract.json` contains synthetic metadata shapes for the Unix-socket contract. Identifiers and names are invented. Tokens, event/message bodies, workspace paths, cwd, browser cookies, launch tokens, credentials, and private user paths must never enter fixtures.

The tracked Sea-Bridge connector is now protocol `1`, runtime version `0.3.0`. Read operations are `health`, `projects.list`, `sessions.list`, `history.follow`, `history.followWindow`, `history.page`, and `models.catalog`. The client fails closed on incomplete bounded listings and validates connector version before use.

The full bridge additionally implements the exact dsh `0.1.7-rc.2` Session Controller write contracts verified from the tagged upstream source:

- `session.create` calls `sessionController.create({ workspaceId, sessionId })`. Sea-Bridge mints a stable explicit session ID so Host create/adopt semantics are idempotent.
- `prompt.submit` calls `sessionController.prompt({ requestId, sessionId, mode: "queue", content: [{ type: "text", text }] }, signal)`. The stable `requestId` is the Host-supported prompt idempotency key.
- `session.selectModel` calls `sessionController.selectModel({ sessionId, provider, model, reasoningEffort? })`.

Write fixture bodies are kept synthetic in unit tests rather than copied from a live user session. Busy/writer-held, proven rejection, and ambiguous delivery are tested as typed outcomes. Unknown or timed-out writes are never automatically replayed.

Important dsh `0.1.7-rc.2` behavior: `selectModel` installs the Session-local next-request model selection and also persists that selection as the Host default asynchronously. The Telegram model UI therefore warns that choosing a model for a Sea-Bridge-created session can affect the default inherited by later Web sessions.
