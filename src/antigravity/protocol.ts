export type JsonRpcId = string | number;

export interface AcpConfigOptionValue {
  value: string;
  name: string;
  description?: string;
}

export interface AcpConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string;
  options: AcpConfigOptionValue[];
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentInfo?: { name?: string; title?: string; version?: string };
  agentCapabilities?: {
    loadSession?: boolean;
    sessionCapabilities?: {
      close?: Record<string, unknown>;
      fork?: Record<string, unknown>;
      list?: Record<string, unknown>;
      resume?: Record<string, unknown>;
    };
  };
}

export interface AcpSessionSetupResult {
  sessionId: string;
  models?: {
    currentModelId?: string;
    availableModels?: Array<{ modelId: string; name: string }>;
  };
  modes?: {
    currentModeId?: string;
    availableModes?: Array<{ id: string; name: string; description?: string }>;
  };
  configOptions?: AcpConfigOption[];
}

export interface AcpPromptResult {
  stopReason: "end_turn" | "cancelled" | "max_tokens" | "max_turn_requests" | "refusal" | string;
  usage?: {
    inputTokens?: number | undefined;
    outputTokens?: number | undefined;
    cachedReadTokens?: number | undefined;
    cachedWriteTokens?: number | undefined;
    thoughtTokens?: number | undefined;
    totalTokens?: number | undefined;
  } | undefined;
}

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
}

export interface AcpPermissionRequestParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    name: string;
    title?: string | undefined;
    kind?: string | undefined;
    status?: string | undefined;
    args?: Record<string, unknown> | undefined;
  };
  options: AcpPermissionOption[];
}

export interface AcpSessionUpdateParams {
  sessionId: string;
  update: {
    sessionUpdate: string;
    content?: { type?: string; text?: string } | Array<{ type?: string; text?: string }>;
    title?: string;
    toolCallId?: string;
    name?: string;
    status?: string;
    kind?: string;
    args?: Record<string, unknown>;
    rawOutput?: Record<string, unknown>;
    availableCommands?: unknown[];
  };
}

export type AcpInboundFrame =
  | { kind: "response"; id: JsonRpcId; result: unknown }
  | { kind: "error"; id: JsonRpcId; error: { code: number; message: string; data?: unknown } }
  | { kind: "notification"; method: string; params: unknown }
  | { kind: "request"; id: JsonRpcId; method: string; params: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return (typeof value === "string" && value.length > 0) || (typeof value === "number" && Number.isFinite(value));
}

/** Parse and classify a single JSON-RPC 2.0 frame from ACP stdout. */
export function parseAcpFrame(rawLine: string): AcpInboundFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLine);
  } catch {
    throw new Error("acp_invalid_json");
  }
  if (!isRecord(parsed) || parsed.jsonrpc !== "2.0") {
    throw new Error("acp_invalid_envelope");
  }

  const hasId = "id" in parsed && parsed.id !== null && parsed.id !== undefined;
  const hasMethod = typeof parsed.method === "string" && parsed.method.length > 0;

  if (hasId && !isJsonRpcId(parsed.id)) {
    throw new Error("acp_invalid_id");
  }

  if (hasId && hasMethod) {
    return {
      kind: "request",
      id: parsed.id as JsonRpcId,
      method: parsed.method as string,
      params: parsed.params,
    };
  }

  if (hasId && "error" in parsed) {
    const err = isRecord(parsed.error) ? parsed.error : {};
    return {
      kind: "error",
      id: parsed.id as JsonRpcId,
      error: {
        code: typeof err.code === "number" ? err.code : -32603,
        message: typeof err.message === "string" ? err.message : "acp_rpc_error",
        data: err.data,
      },
    };
  }

  if (hasId && "result" in parsed) {
    return {
      kind: "response",
      id: parsed.id as JsonRpcId,
      result: parsed.result,
    };
  }

  if (!hasId && hasMethod) {
    return {
      kind: "notification",
      method: parsed.method as string,
      params: parsed.params,
    };
  }

  throw new Error("acp_unrecognized_frame");
}

/** Validate `initialize` result and extract negotiated capabilities. */
export function parseInitializeResult(result: unknown): AcpInitializeResult {
  if (!isRecord(result) || typeof result.protocolVersion !== "number") {
    throw new Error("acp_invalid_initialize_result");
  }
  return result as unknown as AcpInitializeResult;
}

/** Validate `session/new`, `session/load`, or `session/resume` response. */
export function parseSessionSetupResult(result: unknown): AcpSessionSetupResult {
  if (!isRecord(result) || typeof result.sessionId !== "string" || !result.sessionId.trim()) {
    throw new Error("acp_invalid_session_setup_result");
  }
  return result as unknown as AcpSessionSetupResult;
}

/** Validate `session/prompt` result and normalize stopReason. */
export function parsePromptResult(result: unknown): AcpPromptResult {
  if (!isRecord(result)) {
    throw new Error("acp_invalid_prompt_result");
  }
  const stopReason =
    typeof result.stopReason === "string"
      ? result.stopReason
      : typeof result.stop_reason === "string"
        ? result.stop_reason
        : null;
  if (!stopReason) {
    throw new Error("acp_missing_stop_reason");
  }
  return {
    stopReason,
    usage: isRecord(result.usage) ? (result.usage as AcpPromptResult["usage"]) : undefined,
  };
}

/** Validate inbound `session/request_permission` parameters. */
export function parsePermissionRequestParams(params: unknown): AcpPermissionRequestParams {
  if (!isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.toolCall) || !Array.isArray(params.options)) {
    throw new Error("acp_invalid_permission_request");
  }
  const toolCall = params.toolCall;
  const toolCallId =
    typeof toolCall.toolCallId === "string"
      ? toolCall.toolCallId
      : typeof toolCall.tool_call_id === "string"
        ? toolCall.tool_call_id
        : "";
  const name = typeof toolCall.name === "string" ? toolCall.name : "tool";
  if (!toolCallId) {
    throw new Error("acp_missing_tool_call_id");
  }
  const options: AcpPermissionOption[] = [];
  for (const rawOpt of params.options) {
    if (!isRecord(rawOpt)) continue;
    const optionId =
      typeof rawOpt.optionId === "string"
        ? rawOpt.optionId
        : typeof rawOpt.option_id === "string"
          ? rawOpt.option_id
          : "";
    if (!optionId) continue;
    options.push({
      optionId,
      name: typeof rawOpt.name === "string" ? rawOpt.name : optionId,
      kind: typeof rawOpt.kind === "string" ? rawOpt.kind : "unknown",
    });
  }
  if (options.length === 0) {
    throw new Error("acp_empty_permission_options");
  }
  return {
    sessionId: params.sessionId,
    toolCall: {
      toolCallId,
      name,
      title: typeof toolCall.title === "string" ? toolCall.title : name,
      kind: typeof toolCall.kind === "string" ? toolCall.kind : undefined,
      status: typeof toolCall.status === "string" ? toolCall.status : undefined,
      args: isRecord(toolCall.args) ? toolCall.args : undefined,
    },
    options,
  };
}

/** Validate `session/update` notification payload. */
export function parseSessionUpdateParams(params: unknown): AcpSessionUpdateParams {
  if (!isRecord(params) || typeof params.sessionId !== "string" || !isRecord(params.update)) {
    throw new Error("acp_invalid_session_update");
  }
  const update = params.update;
  const sessionUpdate =
    typeof update.sessionUpdate === "string"
      ? update.sessionUpdate
      : typeof update.session_update === "string"
        ? update.session_update
        : "";
  if (!sessionUpdate) {
    throw new Error("acp_missing_session_update_kind");
  }
  return {
    sessionId: params.sessionId,
    update: {
      ...update,
      sessionUpdate,
      toolCallId:
        typeof update.toolCallId === "string"
          ? update.toolCallId
          : typeof update.tool_call_id === "string"
            ? update.tool_call_id
            : undefined,
    } as AcpSessionUpdateParams["update"],
  };
}
