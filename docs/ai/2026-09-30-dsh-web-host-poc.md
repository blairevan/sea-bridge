# dsh Web Host PoC

- Date: 2026-09-30
- Installed dsh CLI: `0.1.7-rc.2`
- Scope: read-only discovery; no session prompt, session creation, profile edit, or credential read was performed.

## Evidence

1. `dsh --version` returned `0.1.7-rc.2`; `dsh --help` identifies `web` as a profile entry mode and exposes no standalone session-control command.
2. A local listener was present at `127.0.0.1:3080`. A bounded, body-discarding `GET /` without browser credentials returned HTTP `401`. This is consistent with the installed Web client-connection documentation; the listener was not otherwise modified or restarted.
3. Installed `@deepseek-ai/dsh-client-connection` documentation states that each Host RPC method and WebSocket stream requires a browser session; there is no method-specific loopback tier. Its documented browser flow exchanges a launch token at the root for an authority-bound signed cookie. It states that the HTTP carrier does not accept an Authorization-header token.
4. Installed `@deepseek-ai/dsh-api-session-controller` documentation describes Host session lifecycle, prompt, history, and follow operations through API Gateway. `@deepseek-ai/dsh-api-gateway` documents generated Client Remote calls and authenticated HTTP/WebSocket carriers. These establish that Host-side operations exist, but not a supported credential path for a separate Sea-Bridge process.
5. Installed `@deepseek-ai/dsh-session-persistence-jsonl` documentation describes durable per-session event logs, compressed by default, and one live writer per session enforced across processes. This confirms that direct file mutation or a second writer is not a safe bridge.

## Capability Results

| Capability | Result | Evidence boundary |
|---|---|---|
| Local Web listener | Observed | Loopback listener and unauthenticated root response; no Host API call was made. |
| Separate-process transport/auth | **Not passed** | Browser-session authentication is documented; no supported Sea-Bridge credential/client entry was found. Do not extract launch tokens, browser cookies, process memory, or credential records. |
| Session observation | **Unavailable to Sea-Bridge** | Host APIs document history/follow, but no independently authenticated caller was verified. |
| Reply to existing session | **Unavailable to Sea-Bridge** | No prompt was sent. Host API presence is not evidence that a separate caller can safely invoke it. |
| Project discovery | **Unverified** | No authenticated project-list request or stable project contract was verified. |
| Model discovery | **Unavailable to Sea-Bridge** | A Host model catalog is documented, but no authenticated request was made. |
| Session creation | **Unavailable to Sea-Bridge** | No session was created; no target project or test session was designated for write PoC. |

No sanitized event/request fixtures were captured because no authenticated Host operation was performed. No session content, credential value, browser data, or process token was read or recorded.

## Decision and next gate

The Sea-Bridge-only connector gate is blocked at external-process authentication. Do not implement a guessed private endpoint, scrape browser/process credentials, expose the Web Host beyond loopback, or start another dsh writer.

The user authorized a separate Task 0A: a temporary, read-only in-profile connector loaded with `dsh web --patch <poc-patch>`. This does not authorize permanent profile edits, credential access, prompt submission, or session creation. The connector must use a fixed allowlist over a local Unix socket and its own short-lived 0600 token. It may call only verified in-process session/workspace read APIs. A second authorization is required before any prompt/create write test.

At the initial checkpoint PID 3794 ran Node with `dsh web --no-open --port 3080 --host 127.0.0.1` and owned the loopback listener. The installed CLI is `0.1.7-rc.2`; top-level `dsh --help` documents repeatable `--patch` overlays. The later temporary runtime mounts restarted the same LaunchAgent and changed the PID; the original profile files and LaunchAgent plist were not modified.

The installed Session Controller declarations are available from the dsh CLI's bundled `node_modules`, not the Web profile's visible `node_modules`. Verified read-only Host methods include `sessionController.list(request, signal)`, `modelCatalog()`, `page(request, signal)`, and `follow(request, signal)`; `WorkspaceRegistry.list()` synchronously returns workspace entities (`id`, `title`, `path`, `sessionIds`, timestamps). The API types define `SessionPageRequest.address` as an ordinary session or direct subagent address, and `SessionFollowRequest` carries that address plus optional bounded history-window settings. The connector must project workspace fields to a minimum safe shape and must not expose filesystem paths by default. Session summaries may include cwd and projections, so the connector must project those too rather than forwarding Host objects wholesale.

`dsh --profile web --dump-config-schema` emitted existing plugin/schema load errors. This is not proof that the temporary overlay fails. Task 0A preflight therefore used a separate `DSH_HOME` and the shipped Web template without launching a second Host:

| Gate | Result | Boundary |
|---|---|---|
| Node import | Passed | Current Node parsed/imported `index.mjs`; `apply()` was not called. |
| Overlay composition | Passed | `--dump-config` baseline had 182 entries; adding the PoC patch produced 183, with only the appended `file:` connector entry. This does **not** prove import or mount. |
| Schema/import diagnostics | No connector-specific error | Both clean temporary-profile schema runs exited 1 with identical two warnings and four pre-existing Loader tree-carrier errors; PoC entry had `status: absent` because no config schema is declared. This does **not** prove runtime mount. |
| Isolated health-socket unit test | Passed | `node --test poc/dsh-web-connector/index.test.mjs` proved authenticated health, rejection of `session.prompt`, private directory/socket/token modes, and disposal cleanup with a fake Cordis context. No real Host service was used. |

## Task 0A runtime acceptance and rollback

With the user's explicit approval, a private temporary copy of LaunchAgent `com.deepseek.dsh` changed only `ProgramArguments` to put `--patch <overlay>` before the Web app flags; it retained the original environment without inspecting its credential values. The original job was booted out before the temporary same-label job bootstrapped; no second Web Host or session writer was launched. An exit trap booted out the temporary job and bootstrapped the original plist even on PoC failure. No permanent profile or original LaunchAgent plist was edited.

| Read capability | Observed result | Boundary |
|---|---|---|
| Transport/auth/health | Passed | Actual Cordis mount answered an authenticated Unix-socket health request. Private run directory, socket, and generated per-mount token file had no group/other access; the token was never printed. |
| Projects | Passed | `ctx.workspaceRegistry.list()` returned 2 registered workspaces through a metadata-only projection (`id`, `title`, `sessionCount`); no `path` crossed the connector. |
| Sessions | Passed | `ctx.sessionController.list({}, signal)` returned 72 visible sessions through a metadata-only projection; no `cwd` or projections crossed the connector. |
| Follow/history | Partially passed | A bounded `follow({ address, maxMessages: 1 }, signal)` returned an opening snapshot. A second independent connection returned a snapshot with a nondecreasing numeric cursor. Post-snapshot live event delivery and gap recovery were **not** verified. |
| Page | Passed for one existing session | `page({ address, throughSeq: followCursor, maxMessages: 1 }, signal)` returned a page. The actual order is follow → page because `throughSeq` comes from the opening snapshot. Only event type/seq/time metadata crossed the connector, not `event.data`. |
| Models | Passed | `modelCatalog()` returned 4 provider groups, 0 isolated failures; only provider/model identity and count were projected, not failure messages or credential/config state. |
| Reply and creation | Not attempted; disabled | No prompt, create, model selection, or session write was called. Separate authorization with a designated test context is still required. |

After each mount, the temporary job was removed and the original job restored. Final check: LaunchAgent PID 18806 again listens at `127.0.0.1:3080`, unauthenticated `GET /` returns 401, the original plist matches its private backup byte-for-byte, and the PoC socket/token are absent. The static/isolated Node tests passed (2 tests); the final `bun test` passed (79 tests, 0 failures); `node --check` for PoC modules, `bash -n` for the rollback script, fixture JSON parse, and `git diff --check` passed. `bun run typecheck` previously entered `bunx` dependency resolution because this worktree has no local TypeScript installation; it was interrupted without installing a dependency. No typecheck success is claimed.

After confirming restoration, the exact private temporary LaunchAgent copies (which may have contained inherited environment values) and the clean-profile dump directory were removed. They were temporary PoC artifacts and are not recoverable; the committed/planned PoC source and original LaunchAgent/profile remain intact. The rollback script requires a new, validated private trial directory if rerun.

Only the PoC's local, read-only transport is proven. The connector is not permanently installed, and production observation/Telegram notification formatting remains outside this acceptance; in particular event text was deliberately not exposed. No credential, browser session, raw session body, real ID, or workspace path was included in the probe output or fixture.


## Task 1 read-only adapter implementation

Task 1 now implements the Sea-Bridge side of the PoC-proven read transport in `src/dsh/` without wiring it into `main.ts` or making the temporary connector permanent.

- `DshWebHostClient` uses the authenticated Unix-socket protocol proven in Task 0A and accepts explicit socket/token paths; it does not guess the deleted PoC runtime files.
- The token is re-read for every request so a connector remount/token rotation does not require rebuilding the client. Runtime directory, socket, and token ownership/private mode are checked before transport use.
- Responses are size/time bounded and validated into metadata-only domain types. Raw Host objects, cwd/path/projections, event bodies, credentials, and token values are not exposed or logged.
- The client exposes only `health`, project/session list, bounded opening `followSnapshot`, history `pageHistory`, and model catalog. There is no prompt/create transport and no generic RPC method.
- Capability evidence is explicit: `transport/projects/models=available`, `observation=partial`, and `reply/creation=unavailable`. Opening follow snapshots plus page/reconnect do not establish continuous live delivery or gap recovery, so production Task 3 observation remains gated.
- The fixture records the verified dsh Host version `0.1.7-rc.2`, while connector protocol `1` is the runtime contract checked by the client. The current connector has no separate safe Host-version RPC, so the adapter does not invent a runtime version value.

Verification after implementation: focused `bun test tests/dsh-web-host-client.test.ts` passed 6/6 and full `bun test` passed 85/85. A Bun build check of the new dsh modules succeeded, the existing PoC Node tests still pass 2/2, and `git diff --check` passes. `bunx --no-install tsc --noEmit` confirmed that no local/cached `tsc` binary is present; it did not install anything, so TypeScript typecheck success is not claimed.
