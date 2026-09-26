import { createHash } from "node:crypto";
import type { ApprovalCoordinator } from "./approval-coordinator.ts";
import type { CodexHookEvent } from "./hook-types.ts";
import type { Logger } from "../logger.ts";
import type {
  AppServerInboundRequest,
  AppServerInboundRequestHandler,
} from "./codex-app-server-client.ts";

function approvalEvent(request: AppServerInboundRequest): CodexHookEvent {
  const params = request.params;
  return {
    session_id: String(params.threadId ?? "unknown"),
    ...(typeof params.turnId === "string" ? { turn_id: params.turnId } : {}),
    hook_event_name: "PermissionRequest",
    ...(typeof params.cwd === "string" ? { cwd: params.cwd } : {}),
    tool_name: request.method,
    tool_input: params,
  };
}

function eventHash(request: AppServerInboundRequest): string {
  return createHash("sha256").update(JSON.stringify({
    method: request.method,
    threadId: request.params.threadId,
    turnId: request.params.turnId,
    itemId: request.params.itemId,
    approvalId: request.params.approvalId,
  })).digest("hex");
}

export function createAppServerApprovalHandler(
  approvals: ApprovalCoordinator,
  logger: Logger,
): AppServerInboundRequestHandler {
  return async (request) => {
    const isCommand = request.method === "item/commandExecution/requestApproval";
    const isFileChange = request.method === "item/fileChange/requestApproval";
    const isPermissions = request.method === "item/permissions/requestApproval";
    if (!isCommand && !isFileChange && !isPermissions) return null;

    const resolution = await approvals.request(eventHash(request), approvalEvent(request));
    const allowed = resolution?.decision === "allow";
    if (resolution) approvals.markDelivered(resolution.approvalId);

    logger.info("app_server_approval_resolved", {
      method: request.method,
      threadId: String(request.params.threadId ?? ""),
      turnId: String(request.params.turnId ?? ""),
      allowed,
    });

    if (isPermissions) {
      return {
        permissions: allowed && request.params.permissions && typeof request.params.permissions === "object"
          ? request.params.permissions as Record<string, unknown>
          : {},
        scope: "turn",
      };
    }

    return { decision: allowed ? "accept" : "decline" };
  };
}
