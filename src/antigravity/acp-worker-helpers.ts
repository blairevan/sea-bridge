import path from "node:path";
import type { SourceSendOptions } from "../web/sources/types.ts";
import type { AntigravityApprovalBridge, ApprovalOutcome } from "./approval-bridge.ts";
import { AcpClient, type AcpClientCallbacks } from "./client.ts";
import type { AntigravityDesktopReader } from "./desktop-reader.ts";
import type { AcpConfigOption, AcpPermissionRequestParams, AcpSessionUpdateParams, JsonRpcId } from "./protocol.ts";
import type { AntigravitySessionRecord, AntigravityStore } from "./store.ts";

export interface DesktopTakeoverController {
  isSessionOpenInDesktopApp(sessionId: string): Promise<boolean>;
  hasOtherRunningDesktopSession(excludeSessionId: string): boolean;
  quitDesktopApp(sessionId?: string): Promise<boolean>;
  markReopenAfterTurn(sessionId: string, chatId?: string | number): void;
}

export type AcpClientFactory = (
  generation: number,
  cwd: string,
  callbacks: AcpClientCallbacks,
  appDataDir?: string | undefined,
) => AcpClient;

/** Apply `model` and optional `thought_level` config options on an initialized ACP session. */
export async function applyAcpModelConfig(
  client: AcpClient,
  sessionId: string,
  baseModelId: string,
  reasoningEffort: string | null,
): Promise<{ modelId: string; reasoningEffort: string | null }> {
  const modelRes = await client.setConfigOption(sessionId, "model", baseModelId);
  let updatedOptions: AcpConfigOption[] = modelRes.configOptions;
  const hasThoughtOption = updatedOptions.some((c) => c.id === "thought_level");
  if (reasoningEffort && hasThoughtOption) {
    updatedOptions = (await client.setConfigOption(sessionId, "thought_level", reasoningEffort)).configOptions;
  }
  return {
    modelId: updatedOptions.find((c) => c.id === "model")?.currentValue ?? baseModelId,
    reasoningEffort:
      updatedOptions.find((c) => c.id === "thought_level")?.currentValue ?? (hasThoughtOption ? reasoningEffort : null),
  };
}

/** Spawn and start an `agy acp` worker process bound to the requested `--app-data-dir`. */
export function spawnAcpWorker(params: {
  generation: number;
  cwd: string;
  cliPath: string;
  geminiDir?: string | undefined;
  appDataDir?: string | undefined;
  approvalPolicy?: "auto" | "ask" | undefined;
  clientFactory?: AcpClientFactory | undefined;
  approvalBridge: AntigravityApprovalBridge;
  getSessionId: () => string | null;
  onSessionUpdate: (sessionId: string | null, update: AcpSessionUpdateParams, generation: number) => void;
  resolveActiveExecution: (targetId: string, generation: number) => string | null;
  onSessionEvent?: ((sessionId: string) => void) | undefined;
}): AcpClient {
  const autoApprove = params.approvalPolicy === "auto";
  const callbacks: AcpClientCallbacks = {
    onSessionUpdate: (update, gen) => params.onSessionUpdate(params.getSessionId(), update, gen),
    onPermissionRequest: async (id: JsonRpcId, req: AcpPermissionRequestParams, gen: number): Promise<ApprovalOutcome> => {
      const targetId = params.getSessionId() ?? req.sessionId;
      const executionId = params.resolveActiveExecution(targetId, gen);
      if (!executionId) return { outcome: { outcome: "cancelled" } };
      const allowOpt = autoApprove
        ? (req.options.find((o) => o.kind.startsWith("allow") || o.optionId === "allow") ?? req.options[0])
        : undefined;
      if (allowOpt) return { outcome: { outcome: "selected", optionId: allowOpt.optionId } };
      const { promise } = params.approvalBridge.requestPermission({
        sessionId: targetId,
        executionId,
        processGeneration: gen,
        rpcRequestId: id,
        request: req,
      });
      params.onSessionEvent?.(targetId);
      return await promise;
    },
  };
  if (params.clientFactory) {
    const custom = params.clientFactory(params.generation, params.cwd, callbacks, params.appDataDir);
    custom.start();
    return custom;
  }
  const args = [
    "acp",
    ...(autoApprove ? ["--dangerously-skip-permissions"] : []),
    ...(params.geminiDir ? [`--gemini-dir=${params.geminiDir}`] : []),
    ...(params.appDataDir ? [`--app-data-dir=${params.appDataDir}`] : []),
  ];
  const client = new AcpClient({ cliPath: params.cliPath, args, cwd: params.cwd, processGeneration: params.generation }, callbacks);
  client.start();
  return client;
}

/** Resolve an existing managed session or prepare an eligible external Desktop/CLI session for P4 adoption. */
export function resolveOrAdoptExternalSession(params: {
  sessionId: string;
  store: AntigravityStore;
  desktopReader?: AntigravityDesktopReader | undefined;
  desktopAppDataDir?: string | undefined;
  externalSessionsEnabled?: boolean | undefined;
  hasActiveTurn: boolean;
  allowWaitingUserInput?: boolean;
}): {
  session?: AntigravitySessionRecord;
  isNewAdoption?: boolean;
  waitingUserInput?: boolean;
  errorCode?: string;
} {
  const { sessionId, store, desktopReader: reader, desktopAppDataDir, externalSessionsEnabled, hasActiveTurn } = params;
  const allowWaiting = Boolean(params.allowWaitingUserInput);
  const inspectExt = () =>
    reader?.inspectAnyExternalSession
      ? reader.inspectAnyExternalSession(sessionId)
      : reader
        ? {
            ...reader.inspectExternalSession(sessionId),
            clientKind: "desktop" as const,
            appDataDirPath: desktopAppDataDir ?? null,
          }
        : null;

  const existing = store.getSession(sessionId);
  if (existing) {
    if (existing.sessionOrigin === "desktop") {
      if (!externalSessionsEnabled) return { errorCode: "desktop_session_read_only" };
      const extNow = inspectExt();
      const waitingUserInput = Boolean(extNow?.waitingUserInput && !hasActiveTurn);
      if (extNow?.externallyRunning && !hasActiveTurn && !(allowWaiting && waitingUserInput)) {
        return { errorCode: "session_busy" };
      }
      return { session: existing, waitingUserInput };
    }
    if (existing.clientTarget === "cli" && !hasActiveTurn) {
      const extNow = inspectExt();
      const waitingUserInput = Boolean(extNow?.waitingUserInput);
      if (extNow?.externallyRunning && !(allowWaiting && waitingUserInput)) {
        return { errorCode: "session_busy" };
      }
      return { session: existing, waitingUserInput };
    }
    return { session: existing, waitingUserInput: false };
  }

  const ext = inspectExt();
  if (!ext || !ext.found) return { errorCode: "session_not_found" };
  if (!externalSessionsEnabled) return { errorCode: "desktop_session_read_only" };
  const waitingUserInput = Boolean(ext.waitingUserInput);
  if (ext.externallyRunning && !(allowWaiting && waitingUserInput)) return { errorCode: "session_busy" };
  if (!ext.projectId || !ext.cwd) return { errorCode: "invalid_project" };

  const desktopDirName = desktopAppDataDir ? path.basename(desktopAppDataDir) : "antigravity";
  const extDirName = ext.appDataDirPath ? path.basename(ext.appDataDirPath) : desktopDirName;
  const now = Date.now();
  const adopted: AntigravitySessionRecord = {
    sessionId,
    nativeSessionId: sessionId,
    sessionOrigin: extDirName === desktopDirName ? "desktop" : "sea_bridge",
    clientTarget: ext.clientKind,
    appDataDir: extDirName,
    projectId: ext.projectId,
    cwd: ext.cwd,
    title: ext.title || sessionId,
    modelId: null,
    reasoningEffort: null,
    modeId: "default",
    status: "idle",
    completeHistory: true,
    snapshotGeneration: 1,
    lastExecutionId: null,
    lastExecutionEpoch: 0,
    createdAt: ext.updatedAt || now,
    updatedAt: ext.updatedAt || now,
  };
  return { session: adopted, isNewAdoption: true, waitingUserInput };
}

/**
 * Release the exclusive Desktop `<sessionId>.lock` held by `Antigravity.app` when answering a
 * Desktop `waiting_user_input` prompt, enforcing `1A` concurrency protection unless forced.
 */
export async function prepareDesktopQuestionTakeover(params: {
  session: AntigravitySessionRecord;
  waitingUserInput: boolean;
  options?: SourceSendOptions | undefined;
  controller?: DesktopTakeoverController | null | undefined;
}): Promise<{ ok: true } | { ok: false; errorCode: string }> {
  const { session, waitingUserInput, options, controller } = params;
  if (session.sessionOrigin !== "desktop" || !waitingUserInput || !controller) {
    return { ok: true };
  }
  const openInDesktop = await controller.isSessionOpenInDesktopApp(session.sessionId);
  if (!openInDesktop) {
    return { ok: true };
  }
  if (!options?.forceDesktopTakeover && controller.hasOtherRunningDesktopSession(session.sessionId)) {
    return { ok: false, errorCode: "desktop_takeover_confirm_required" };
  }
  const quitOk = await controller.quitDesktopApp(session.sessionId);
  if (!quitOk) {
    return { ok: false, errorCode: "desktop_app_busy_lock" };
  }
  controller.markReopenAfterTurn(session.sessionId, options?.notifyChatId);
  return { ok: true };
}
