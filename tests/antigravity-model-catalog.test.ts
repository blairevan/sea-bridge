import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { AntigravityModelCatalog, parseAgyModelsOutput } from "../src/antigravity/model-catalog.ts";

const fixturePath = path.join(import.meta.dir, "fixtures", "antigravity-acp", "agy-models.txt");

describe("AntigravityModelCatalog", () => {
  test("strips spinner control frames and aggregates 13 variants into 5 base models with separate reasoning efforts", () => {
    const raw = "\r⠋ Fetching available models...\r" + readFileSync(fixturePath, "utf8");
    const parsed = parseAgyModelsOutput(raw);
    const tabSeparated = parseAgyModelsOutput(readFileSync(fixturePath, "utf8").replace(/\s{2,}/g, "\t"));
    expect(tabSeparated.items).toEqual(parsed.items);

    expect(parsed.items).toEqual([
      {
        id: "gemini-4-argon",
        name: "Gemini 4 Argon",
        defaultReasoningEffort: "medium",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
      {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
      {
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
      {
        id: "claude-sonnet-5-5",
        name: "Claude Sonnet 5.5",
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high"],
      },
      {
        id: "gpt-oss-120b-medium",
        name: "GPT-OSS 120B (Medium)",
      },
    ]);
  });

  test("resolves (modelId, reasoningEffort) bidirectionally and caches results", async () => {
    const raw = readFileSync(fixturePath, "utf8");
    let calls = 0;
    const catalog = new AntigravityModelCatalog({
      cliPath: "/Users/zhuhaijun/.local/bin/agy",
      ttlMs: 60_000,
      runner: async () => {
        calls++;
        return raw;
      },
    });

    const models1 = await catalog.listModels(1000);
    const models2 = await catalog.listModels(2000);
    expect(models1).toHaveLength(5);
    expect(models2).toHaveLength(5);
    expect(calls).toBe(1);

    const sel1 = await catalog.resolveSelection("gemini-4-argon", "high", 2000);
    expect(sel1).toEqual({
      baseModelId: "gemini-4-argon",
      displayName: "Gemini 4 Argon",
      reasoningEffort: "high",
      variantId: "gemini-4-argon-high",
    });

    const sel2 = await catalog.resolveSelection("gemini-3.8-flash", null, 2000);
    expect(sel2).toEqual({
      baseModelId: "gemini-3.8-flash",
      displayName: "Gemini 3.8 Flash",
      reasoningEffort: "high",
      variantId: "gemini-3.8-flash-high",
    });

    const sel3 = await catalog.resolveSelection("gpt-oss-120b-medium", null, 2000);
    expect(sel3).toEqual({
      baseModelId: "gpt-oss-120b-medium",
      displayName: "GPT-OSS 120B (Medium)",
      reasoningEffort: null,
      variantId: "gpt-oss-120b-medium",
    });

    expect(await catalog.resolveSelection("gemini-4-argon", "ultra", 2000)).toBeNull();

    expect(catalog.splitVariantId("claude-opus-5-5-high")).toEqual({
      model: { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
      reasoningEffort: "high",
    });
    expect(catalog.splitVariantId("gpt-oss-120b-medium")).toEqual({
      model: { id: "gpt-oss-120b-medium", displayName: "GPT-OSS 120B (Medium)" },
    });
  });

  test("degrades gracefully to empty list when agy models fails", async () => {
    const catalog = new AntigravityModelCatalog({
      cliPath: "/nonexistent/agy",
      runner: async () => {
        throw new Error("spawn_failed");
      },
    });
    expect(await catalog.listModels()).toEqual([]);
  });
});
