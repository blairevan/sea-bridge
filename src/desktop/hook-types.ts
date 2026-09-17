export type HookEventName = "PermissionRequest" | "Stop" | "UserPromptSubmit" | "Interrupt" | "SessionStart" | "SessionEnd" | string;

export interface CodexHookEvent {
  session_id: string;
  turn_id?: string;
  hook_event_name: HookEventName;
  transcript_path?: string | null;
  cwd?: string;
  model?: string;
  permission_mode?: string;
  tool_name?: string;
  tool_input?: unknown;
  prompt?: string;
  stop_hook_active?: boolean;
  last_assistant_message?: string | null;
  [key: string]: unknown;
}

export interface HookTransportRequest {
  protocolVersion: 1;
  invocationId: string;
  sentAt: number;
  event: CodexHookEvent;
}

export interface HookTransportResponse {
  protocolVersion: 1;
  invocationId: string;
  output: Record<string, unknown> | null;
  error?: string;
}

export function permissionOutput(decision: "allow" | "deny", message?: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: decision, ...(message ? { message } : {}) },
    },
  };
}

export function stopContinuationOutput(reason: string): Record<string, unknown> {
  return { decision: "block", reason };
}
