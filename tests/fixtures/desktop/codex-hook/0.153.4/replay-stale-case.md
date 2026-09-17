# Replay and Stale Event Analysis & Protection Contract

## Threat Model (P0 Priority)

In Codex Desktop 0.153.4, when a desktop turn crashes, restarts, or undergoes post-turn compaction/indexing, older hook events or historical session entries can be re-evaluated. If Sea-Bridge does not enforce strict turn freshness, a stale event could:
1. Re-open an approval card for a turn that has already executed or aborted;
2. Cause an approval to apply to the WRONG turn or tool call;
3. Inject a continuation message into an idle or terminated thread.

## Defense Layers Implemented in Sea-Bridge

### 1. Same-Turn Freshness Proof (isFreshSameTurn)
- Hook event must contain non-empty turn_id.
- Active session store must have recorded the session in 'active' state for the exact same turn_id.
- Elapsed time since last seen must be within activeSessionTtlMs (default 10 minutes).
- If requireFreshTranscript is enabled, the session transcript file's mtime must be <= active TTL.

### 2. Transport Age Guard
- Python wrapper attaches sentAt timestamp inside the protocol envelope.
- Sea-Bridge rejects any request where Date.now() - sentAt > maxTransportAgeMs (default 30 seconds).

### 3. Event Deduplication & CAS
- SHA-256 hash of the normalized event payload is computed.
- If duplicate event hash is detected within active window, it is logged and rejected immediately (duplicate: true).
- Approval callback uses one-time SHA-256 hashed opaque token. Once selected, row transitions to 'selected' via CAS and cannot be re-resolved.
- Continuation queue uses CAS (status: 'pending' -> 'claimed' -> 'consumed').
