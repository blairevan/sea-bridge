import type { AntigravityApprovalBridge, ApprovalOutcome } from "./approval-bridge.ts";
import { AcpClient, type AcpClientCallbacks } from "./client.ts";
import type { AcpConfigOption, AcpPermissionRequestParams, AcpSessionUpdateParams, JsonRpcId } from "./protocol.ts";

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
