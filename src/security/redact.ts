const SECRET_KEY = /(authorization|cookie|token|secret|password|api[_-]?key|credential|private[_-]?key)/i;

function redactValue(value: unknown, depth: number): unknown {
  if (depth > 5) return "[depth-limited]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      result[key] = SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(entry, depth + 1);
    }
    return result;
  }
  if (typeof value === "string") {
    return value
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[REDACTED]")
      .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]");
  }
  return value;
}

export function redact(value: unknown): unknown {
  return redactValue(value, 0);
}

export function redactedJson(value: unknown, maxLength = 4000): string {
  const text = JSON.stringify(redact(value));
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}…`;
}
