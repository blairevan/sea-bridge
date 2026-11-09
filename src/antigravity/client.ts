import {
  parseInitializeResult,
  parsePermissionRequestParams,
  parsePromptResult,
  parseSessionSetupResult,
  parseSessionUpdateParams,
  type AcpConfigOption,
  type AcpInitializeResult,
  type AcpPermissionRequestParams,
  type AcpPromptResult,
  type AcpSessionSetupResult,
  type AcpSessionUpdateParams,
  type JsonRpcId,
} from "./protocol.ts";
import { AcpStdioTransport, type AcpTransportOptions } from "./transport.ts";

export interface AcpClientCallbacks {
  onSessionUpdate?: (update: AcpSessionUpdateParams, generation: number) => void;
  onPermissionRequest?: (
    id: JsonRpcId,
    request: AcpPermissionRequestParams,
    generation: number
  ) => Promise<{ outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } }>;
  onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; generation: number }) => void;
}

/** High-level typed ACP v1 client wrapping `AcpStdioTransport`. */
export class AcpClient {
  private readonly transport: AcpStdioTransport;

  constructor(
    options: Omit<AcpTransportOptions, "onNotification" | "onRequest" | "onExit">,
    callbacks: AcpClientCallbacks = {}
  ) {
    this.transport = new AcpStdioTransport({
      ...options,
      onNotification: (method, params) => {
        if (method === "session/update") {
          try {
            const parsed = parseSessionUpdateParams(params);
            callbacks.onSessionUpdate?.(parsed, options.processGeneration);
          } catch {
            // Ignore malformed notification frames
          }
        }
      },
      onRequest: async (id, method, params) => {
        if (method === "session/request_permission") {
          const parsed = parsePermissionRequestParams(params);
          if (!callbacks.onPermissionRequest) {
            return { outcome: { outcome: "cancelled" } };
          }
          return await callbacks.onPermissionRequest(id, parsed, options.processGeneration);
        }
        throw new Error(`unsupported_inbound_method:${method}`);
      },
      onExit: callbacks.onExit,
    });
  }

  /** Start the underlying stdio process. */
  start(): void {
    this.transport.start();
  }

  /** Return process identity and generation metadata. */
  identity(): { pid: number | null; startedAt: number | null; generation: number; closed: boolean } {
    return this.transport.identity();
  }

  /** Perform ACP `initialize` handshake. */
  async initialize(clientInfo = { name: "sea-bridge", version: "1.2.4" }): Promise<AcpInitializeResult> {
    const { promise } = this.transport.request("initialize", {
      protocolVersion: 1,
      clientInfo,
      clientCapabilities: {},
    });
    return parseInitializeResult(await promise);
  }

  /** Create a new ACP session (`session/new`). */
  async sessionNew(cwd: string): Promise<AcpSessionSetupResult> {
    const { promise } = this.transport.request("session/new", {
      cwd,
      mcpServers: [],
    });
    return parseSessionSetupResult(await promise);
  }

  /** Load an existing ACP session with history replay (`session/load`). */
  async sessionLoad(sessionId: string, cwd: string): Promise<AcpSessionSetupResult> {
    const { promise } = this.transport.request("session/load", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    return parseSessionSetupResult(await promise);
  }

  /** Resume an existing ACP session without history replay (`session/resume`). */
  async sessionResume(sessionId: string, cwd: string): Promise<AcpSessionSetupResult> {
    const { promise } = this.transport.request("session/resume", {
      sessionId,
      cwd,
      mcpServers: [],
    });
    return parseSessionSetupResult(await promise);
  }

  /** Set a session config option (`model`, `thought_level`, or `mode`). */
  async setConfigOption(
    sessionId: string,
    configId: "model" | "thought_level" | "mode" | string,
    value: string
  ): Promise<{ configOptions: AcpConfigOption[] }> {
    const { promise } = this.transport.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
    const res = (await promise) as { configOptions?: AcpConfigOption[] } | null;
    return {
      configOptions: Array.isArray(res?.configOptions) ? res.configOptions : [],
    };
  }

  /** Send a prompt turn (`session/prompt`). Uses unbounded timeout (0) while turn streams updates. */
  prompt(sessionId: string, text: string): { rpcRequestId: string; promise: Promise<AcpPromptResult> } {
    const { id, promise } = this.transport.request(
      "session/prompt",
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      0
    );
    return {
      rpcRequestId: String(id),
      promise: promise.then((res) => parsePromptResult(res)),
    };
  }

  /** Send a `session/cancel` notification for an active session turn. */
  async cancel(sessionId: string): Promise<void> {
    await this.transport.notify("session/cancel", { sessionId });
  }

  /** Close an active session (`session/close`). */
  async closeSession(sessionId: string): Promise<void> {
    const { promise } = this.transport.request("session/close", { sessionId });
    await promise;
  }

  /** Terminate the underlying worker process. */
  close(): void {
    this.transport.close();
  }
}
