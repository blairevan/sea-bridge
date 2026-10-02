import { isIP } from "node:net";
import type { WebSettings } from "./store.ts";

const SECRET_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|credential|private[_-]?key)/i;
const HIDDEN = "[REDACTED]";

import { filterSecretText } from "../security/redact.ts";

/** Hide recognizable ordinary privacy fields only for display-enabled policies. */
function filterPrivacyText(text: string): string {
  return text
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]")
    .replace(/(?:\+?86[ -]?)?1[3-9]\d{9}\b/g, "[PHONE]")
    .replace(/\+\d[\d ()-]{7,}\d/g, "[PHONE]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) => isIP(value) ? "[IP]" : value)
    .replace(/(?<![\w:])[\da-f]*:[\da-f:]+(?:%[\w.-]+)?/gi, (value) => isIP(value) ? "[IP]" : value)
    .replace(/\b[A-Z]:\\[^\s"'<>]+/gi, "[PATH]")
    .replace(/(?<![\w:/])\/(?:[^\s/"'<>]+\/)*[^\s/"'<>]+/g, "[PATH]");
}

/** Shared Web filtering policy; source prompts bypass this display/storage boundary. */
export class WebRedaction {
  private readonly secrets: readonly string[];

  /** Exact known values are sorted longest-first to avoid partial credential exposure. */
  constructor(secrets: readonly string[]) {
    this.secrets = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length);
  }

  /** Return a new structure with permanent credential filtering applied. */
  storage<T>(value: T): T { return this.filter(value, false, 0) as T; }

  /** Apply one immutable settings snapshot to the whole response structure. */
  display<T>(value: T, settings: WebSettings): T {
    return this.filter(value, settings.redactionEnabled, 0) as T;
  }

  /** Build version metadata from exactly the policy used to filter the payload. */
  response<T>(data: T, settings: WebSettings): { data: T; settingsVersion: number } {
    return { data: this.display(data, settings), settingsVersion: settings.version };
  }

  /** Traverse JSON-compatible data with a depth bound and no mutations to callers. */
  private filter(value: unknown, privacy: boolean, depth: number): unknown {
    if (depth > 20) return "[depth-limited]";
    if (typeof value === "string") {
      const safe = filterSecretText(value, this.secrets);
      return privacy ? filterPrivacyText(safe) : safe;
    }
    if (Array.isArray(value)) return value.map((item) => this.filter(item, privacy, depth + 1));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, item] of Object.entries(value)) {
        const machineIdentity = ["id", "cursor", "sessionId", "projectId", "modelId", "deviceId", "currentDeviceId", "operationId"].includes(key);
        result[key] = SECRET_KEY.test(key) ? HIDDEN : this.filter(item, privacy && !machineIdentity, depth + 1);
      }
      return result;
    }
    return value;
  }
}
