/** Normalized creation provenance; raw native client names never leave the desktop boundary. */
export interface CreationClient {
  kind: "desktop" | "cli" | "sea_bridge" | "exec" | "unknown";
  evidence: "originator" | "source" | "none";
}

/** Validate before trimming so invalid evidence cannot trigger a source fallback. */
function boundedValue(value: unknown): string | null {
  if (value === null || value === undefined) return "";
  return typeof value === "string" && value.length <= 200 ? value.trim() : null;
}

/** Classify exact native creation metadata without guessing the current executor. */
export function classifyCreationClient(source: unknown, originator: unknown): CreationClient {
  const client = boundedValue(originator);
  const nativeSource = boundedValue(source);
  if (client === null || nativeSource === null) return { kind: "unknown", evidence: "none" };
  if (client) {
    const kind = client === "Codex Desktop" ? "desktop" : client === "codex-tui" ? "cli"
      : client === "sea-bridge" ? "sea_bridge" : client === "codex_exec" ? "exec" : "unknown";
    return { kind, evidence: "originator" };
  }
  if (nativeSource === "cli" || nativeSource === "exec") return { kind: nativeSource, evidence: "source" };
  return { kind: "unknown", evidence: "none" };
}
