import { expect, test } from "bun:test";
import { classifyCreationClient } from "../src/desktop/codex-provenance.ts";

test("exact originators outrank broad session sources", () => {
  for (const [originator, kind] of [["Codex Desktop", "desktop"], ["codex-tui", "cli"], ["sea-bridge", "sea_bridge"], ["codex_exec", "exec"]] as const) {
    expect(classifyCreationClient("vscode", originator)).toEqual({ kind, evidence: "originator" });
  }
  for (const source of ["cli", "exec", "vscode"]) {
    expect(classifyCreationClient(source, "private-client")).toEqual({ kind: "unknown", evidence: "originator" });
  }
});

test("missing originators permit only explicit cli and exec fallback", () => {
  expect(classifyCreationClient("cli", null)).toEqual({ kind: "cli", evidence: "source" });
  expect(classifyCreationClient("exec", " ")).toEqual({ kind: "exec", evidence: "source" });
  for (const source of ["vscode", null, "other", 12, "x".repeat(201)]) {
    expect(classifyCreationClient(source, null).kind).toBe("unknown");
  }
  for (const originator of [12, "x".repeat(201), "codex desktop", "Codex Desktop custom"]) {
    expect(classifyCreationClient("cli", originator).kind).toBe("unknown");
  }
  expect(classifyCreationClient(" vscode ", " Codex Desktop ").kind).toBe("desktop");
});
