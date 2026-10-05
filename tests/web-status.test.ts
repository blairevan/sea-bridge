import { describe, expect, test } from "bun:test";
import { createStatusService } from "../src/web/status.ts";
import type { WebSource, WebSourceCapabilities, WebSourceStatusState } from "../src/web/sources/types.ts";

const capabilities: WebSourceCapabilities = {
  sessionsReadable: true,
  projectsReadable: false,
  modelsReadable: false,
  historyReadable: false,
  completeUserHistoryReadable: false,
  finalReplyReadable: false,
  createEnabled: false,
  sendEnabled: true,
  approvalTransport: "telegram",
};

function source(state: WebSourceStatusState, fail = false): WebSource {
  return {
    statusState: () => state,
    statusDetails: () => ({ catalog: state, history: "degraded", notifications: "ready" }),
    capabilities: () => capabilities,
    sessions: async () => { if (fail) throw new Error("offline"); return []; },
    projects: async () => [],
    models: async () => [],
    history: async () => ({ messages: [], cursor: null, completeUserHistory: false }),
    create: async () => ({ state: "failed", sessionId: null }),
    send: async (id) => ({ state: "failed", sessionId: id }),
  };
}

describe("Web source status projection", () => {
  test("preserves stale and reinitialize states instead of collapsing them to unavailable", async () => {
    const stale = createStatusService({ codex: source("stale") }, () => ({ stopped: false, lastPollSuccessAt: 1, pollFailed: false }));
    expect((await stale()).sources?.codex).toMatchObject({ state: "stale", details: { history: "degraded", notifications: "ready" } });

    const reinitialize = createStatusService({ codex: source("reinitialize_required", true) }, () => ({ stopped: false, lastPollSuccessAt: 1, pollFailed: false }));
    expect((await reinitialize()).sources?.codex).toMatchObject({ state: "reinitialize_required" });
  });

  test("ordinary sources keep the existing limited projection", async () => {
    const status = createStatusService({ codex: source("limited") }, () => ({ stopped: false, lastPollSuccessAt: null, pollFailed: false }));
    expect((await status()).sources?.codex).toMatchObject({ state: "limited" });
  });

  test("status actively probes capabilities instead of reporting only previously used features", async () => {
    let probes = 0;
    const sampled = { ...capabilities };
    const probed = source("limited");
    probed.probeCapabilities = async () => {
      probes += 1;
      sampled.projectsReadable = true;
      sampled.modelsReadable = true;
      sampled.historyReadable = true;
      sampled.finalReplyReadable = true;
      sampled.createEnabled = true;
    };
    probed.capabilities = () => sampled;
    const status = createStatusService({ codex: probed }, () => ({ stopped: false, lastPollSuccessAt: 1, pollFailed: false }));
    expect((await status()).sources?.codex).toMatchObject({
      capabilities: { projectsReadable: true, modelsReadable: true, historyReadable: true, createEnabled: true },
    });
    expect(probes).toBe(1);
    await status();
    expect(probes).toBe(1);
  });
});
