# dsh Web Host Fixtures

Verified dsh CLI version during initial read-only PoC: `0.1.7-rc.2`.

`read-contract.json` contains synthetic example shapes for the PoC-proven Unix-socket operations. The real connector authenticates every request with a generated token stored outside this repository; examples omit the token. Session/workspace/model identifiers and names in the fixture are invented, not copied from the Host. Event data, workspace paths, cwd, browser cookies, launch tokens, and credentials must never enter fixtures.

The observed installed Host was `0.1.7-rc.2`. Opening follow snapshots and one history page passed; live incremental follow and gap recovery are not represented as verified behavior. Prompt/create are not in the connector allowlist.

Task 1 binds Sea-Bridge to connector protocol `1` only. The typed client exposes `health`, `listProjects`, `listSessions`, `followSnapshot`, `pageHistory`, and `listModels`; it deliberately has no `readEvents`, `submitPrompt`, or `createSession` method. Socket and token paths are injected explicitly, so the deleted PoC runtime filenames are not treated as a production default.
