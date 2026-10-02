import { operationDigest } from "./crypto.ts";
import type { WebStore, WebOperation } from "./store.ts";
import type { WebRedaction } from "./redaction.ts";
import type { WebSource } from "./sources/types.ts";

/** Browser operation input is validated before being durably claimed. */
export interface WebWriteRequest {
  operationId: string; source: "codex" | "dsh"; kind: "create" | "send";
  targetId: string | null; projectId: string | null; modelId: string | null; prompt: string;
}

/** Atomically claim and dispatch once; no transport failure triggers an implicit replay. */
export async function dispatchWebOperation(input: WebWriteRequest, deviceId: string, source: WebSource, store: WebStore, pepper: Uint8Array, redaction: WebRedaction): Promise<WebOperation> {
  const digest = operationDigest(pepper, input);
  const claim = store.claimOperation({ id: input.operationId, digest, kind: input.kind, source: input.source, deviceId,
    targetId: input.targetId, projectId: input.projectId, modelId: input.modelId, createdAt: Date.now() });
  if (claim === "mismatch") throw new Error("operation_conflict");
  const prior = store.getOperation(input.operationId);
  if (!prior) throw new Error("operation_missing");
  if (prior.state !== "received") return prior;
  // Persist the display-only snapshot before crossing the dispatch boundary. A local failure here is
  // definite because no source call has happened, so do not mislabel it as an ambiguous delivery.
  try {
    store.db.query("INSERT OR IGNORE INTO web_message_snapshots(operation_id,source,session_id,text,created_at) VALUES(?,?,?,?,?)").run(input.operationId, input.source, input.targetId, redaction.storage(input.prompt), Date.now());
  } catch {
    store.transitionOperation(input.operationId, "received", "failed", Date.now(), "local_persistence_failed");
    const failed = store.getOperation(input.operationId);
    if (!failed) throw new Error("operation_missing");
    return failed;
  }
  if (!store.transitionOperation(input.operationId, "received", "dispatching", Date.now())) {
    const raced = store.getOperation(input.operationId); if (!raced) throw new Error("operation_missing"); return raced;
  }
  try {
    const result = input.kind === "create" ? await source.create({ operationId: input.operationId, projectId: input.projectId ?? "", modelId: input.modelId, prompt: input.prompt,
      onSessionKnown: (id) => { store.setOperationSession(input.operationId, id, Date.now()); },
    }) : await source.send(input.targetId ?? "", input.operationId, input.prompt);
    if (result.sessionId) {
      store.setOperationSession(input.operationId, result.sessionId, Date.now(), result.turnId ?? null);
      store.db.query("UPDATE web_message_snapshots SET session_id=? WHERE operation_id=?").run(result.sessionId, input.operationId);
    }
    store.transitionOperation(input.operationId, "dispatching", result.state, Date.now(), result.errorCode ?? null);
  } catch { store.transitionOperation(input.operationId, "dispatching", "delivery_unknown", Date.now(), "dispatch_unconfirmed"); }
  const operation = store.getOperation(input.operationId);
  if (!operation) throw new Error("operation_missing");
  if (operation.state === "failed") {
    try { store.db.query("DELETE FROM web_message_snapshots WHERE operation_id=?").run(input.operationId); }
    catch { /* Snapshot cleanup must not rewrite a definite source outcome. */ }
  }
  return operation;
}
