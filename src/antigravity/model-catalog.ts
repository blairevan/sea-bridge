import { spawn } from "node:child_process";
import type { CatalogItem } from "../web/sources/types.ts";

export interface ParsedAntigravityCatalog {
  items: CatalogItem[];
  variantToFamily: Map<string, { baseId: string; baseName: string; reasoningEffort?: string | undefined }>;
  familyToVariants: Map<string, Map<string, string>>;
}

const ANSI_REGEX = /\x1B\[[0-9;]*[A-Za-z]/g;
const EFFORT_ORDER = ["low", "medium", "high"] as const;

interface RawVariantEntry {
  variantId: string;
  displayName: string;
  baseId: string;
  baseName: string;
  effort: string | null;
}

/** Strip terminal carriage-return spinner frames and ANSI sequences, then aggregate by model family. */
export function parseAgyModelsOutput(rawOutput: string): ParsedAntigravityCatalog {
  const entries: RawVariantEntry[] = [];
  const lines = rawOutput.split(/\n/);

  for (const rawLine of lines) {
    const afterCarriage = rawLine.split("\r").at(-1) ?? "";
    const clean = afterCarriage.replace(ANSI_REGEX, "").trim();
    if (!clean) continue;

    const match = clean.match(/^([a-z0-9][a-z0-9._-]*)(?:\t+|\s{2,})(.+)$/i);
    if (!match) continue;
    const variantId = match[1]!.trim();
    const displayName = match[2]!.trim();

    const idEffortMatch = variantId.match(/^(.+)-(low|medium|high)$/i);
    const nameEffortMatch = displayName.match(/^(.+?)\s*\((Low|Medium|High)\)$/i);

    if (idEffortMatch && nameEffortMatch) {
      entries.push({
        variantId,
        displayName,
        baseId: idEffortMatch[1]!,
        baseName: nameEffortMatch[1]!.trim(),
        effort: idEffortMatch[2]!.toLowerCase(),
      });
    } else {
      entries.push({
        variantId,
        displayName,
        baseId: variantId,
        baseName: displayName,
        effort: null,
      });
    }
  }

  const groups = new Map<string, RawVariantEntry[]>();
  for (const entry of entries) {
    const list = groups.get(entry.baseId) ?? [];
    list.push(entry);
    groups.set(entry.baseId, list);
  }

  const items: CatalogItem[] = [];
  const variantToFamily = new Map<string, { baseId: string; baseName: string; reasoningEffort?: string | undefined }>();
  const familyToVariants = new Map<string, Map<string, string>>();

  for (const [baseId, group] of groups.entries()) {
    const distinctEfforts = new Set(group.map((g) => g.effort).filter((e): e is string => Boolean(e)));
    if (distinctEfforts.size > 1) {
      const first = group[0]!;
      const defaultReasoningEffort = first.effort ?? "medium";
      const supportedReasoningEfforts = EFFORT_ORDER.filter((e) => distinctEfforts.has(e));
      items.push({
        id: baseId,
        name: first.baseName,
        defaultReasoningEffort,
        supportedReasoningEfforts,
      });
      const effortMap = new Map<string, string>();
      for (const member of group) {
        if (member.effort) {
          effortMap.set(member.effort, member.variantId);
          variantToFamily.set(member.variantId, {
            baseId,
            baseName: first.baseName,
            reasoningEffort: member.effort,
          });
        }
      }
      variantToFamily.set(baseId, {
        baseId,
        baseName: first.baseName,
        reasoningEffort: defaultReasoningEffort,
      });
      familyToVariants.set(baseId, effortMap);
    } else {
      for (const member of group) {
        items.push({
          id: member.variantId,
          name: member.displayName,
        });
        variantToFamily.set(member.variantId, {
          baseId: member.variantId,
          baseName: member.displayName,
        });
      }
    }
  }

  return { items, variantToFamily, familyToVariants };
}

/** Read-only catalog service for `agy models` with TTL cache and bidirectional family/effort resolution. */
export class AntigravityModelCatalog {
  private cached: { parsed: ParsedAntigravityCatalog; expiresAt: number } | null = null;

  constructor(
    private readonly options: {
      cliPath: string;
      geminiDir?: string | undefined;
      appDataDir?: string | undefined;
      timeoutMs?: number | undefined;
      ttlMs?: number | undefined;
      runner?: (() => Promise<string>) | undefined;
    }
  ) {}

  /** Return aggregated base models and their supported reasoning efforts. */
  async listModels(now = Date.now()): Promise<CatalogItem[]> {
    const parsed = await this.loadParsed(now);
    return parsed.items;
  }

  /** Invalidate the cached model catalog. */
  invalidate(): void {
    this.cached = null;
  }

  /** Resolve `(modelId, reasoningEffort)` into `{ baseModelId, displayName, reasoningEffort, variantId }`. */
  async resolveSelection(
    modelId: string,
    reasoningEffort?: string | null,
    now = Date.now()
  ): Promise<{ baseModelId: string; displayName: string; reasoningEffort: string | null; variantId: string } | null> {
    const parsed = await this.loadParsed(now);
    const trimmedModel = modelId.trim();
    if (!trimmedModel) return null;

    const item = parsed.items.find((i) => i.id === trimmedModel);
    if (item) {
      if (item.supportedReasoningEfforts && item.supportedReasoningEfforts.length > 0) {
        const chosenEffort = reasoningEffort?.trim().toLowerCase() || item.defaultReasoningEffort || "medium";
        if (!item.supportedReasoningEfforts.includes(chosenEffort)) {
          return null;
        }
        const variantId = parsed.familyToVariants.get(item.id)?.get(chosenEffort) ?? `${item.id}-${chosenEffort}`;
        return {
          baseModelId: item.id,
          displayName: item.name,
          reasoningEffort: chosenEffort,
          variantId,
        };
      }
      return {
        baseModelId: item.id,
        displayName: item.name,
        reasoningEffort: null,
        variantId: item.id,
      };
    }

    const mapped = parsed.variantToFamily.get(trimmedModel);
    if (mapped) {
      return {
        baseModelId: mapped.baseId,
        displayName: mapped.baseName,
        reasoningEffort: mapped.reasoningEffort ?? null,
        variantId: trimmedModel,
      };
    }

    return null;
  }

  /** Split a raw model ID or base model ID into `WebSessionMeta` fields (`model` + `reasoningEffort`). */
  splitVariantId(
    rawModelId: string | null | undefined,
    explicitEffort?: string | null
  ): { model?: { id: string; displayName?: string }; reasoningEffort?: string } {
    if (!rawModelId) return {};
    const parsed = this.cached?.parsed;
    if (parsed) {
      const mapped = parsed.variantToFamily.get(rawModelId);
      if (mapped) {
        const effort = explicitEffort ?? mapped.reasoningEffort;
        return {
          model: { id: mapped.baseId, displayName: mapped.baseName },
          ...(effort ? { reasoningEffort: effort } : {}),
        };
      }
    }

    if (rawModelId === "gpt-oss-120b-medium") {
      return { model: { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)" } };
    }
    const match = rawModelId.match(/^(.+)-(low|medium|high)$/i);
    if (match) {
      return {
        model: { id: match[1]! },
        reasoningEffort: (explicitEffort ?? match[2]!).toLowerCase(),
      };
    }
    return {
      model: { id: rawModelId },
      ...(explicitEffort ? { reasoningEffort: explicitEffort } : {}),
    };
  }

  private async loadParsed(now: number): Promise<ParsedAntigravityCatalog> {
    if (this.cached && this.cached.expiresAt > now) {
      return this.cached.parsed;
    }
    try {
      const raw = this.options.runner ? await this.options.runner() : await this.execAgyModels();
      const parsed = parseAgyModelsOutput(raw);
      if (parsed.items.length > 0) {
        const ttl = this.options.ttlMs ?? 300_000;
        this.cached = { parsed, expiresAt: now + ttl };
        return parsed;
      }
    } catch {
      // Fall back to empty catalog if CLI probe fails or times out
    }
    return {
      items: [],
      variantToFamily: new Map(),
      familyToVariants: new Map(),
    };
  }

  private execAgyModels(): Promise<string> {
    const timeoutMs = this.options.timeoutMs ?? 8_000;
    const args = ["models"];

    return new Promise((resolve, reject) => {
      const child = spawn(this.options.cliPath, args, {
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
      });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {
          // ignore
        }
        reject(new Error("agy_models_timeout"));
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new Error(`agy_models_exit_${code}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
    });
  }
}
