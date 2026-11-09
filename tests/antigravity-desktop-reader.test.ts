import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AntigravityDesktopReader } from "../src/antigravity/desktop-reader.ts";

describe("AntigravityDesktopReader", () => {
  test("lists only top-level non-killed desktop sessions, maps running/idle status, matches projectId, and hydrates truncated transcript lines", () => {
    const root = mkdtempSync(path.join(tmpdir(), "agy-desktop-reader-"));
    try {
      const dbPath = path.join(root, "conversation_summaries.db");
      const db = new Database(dbPath, { create: true });
      db.exec(`
        CREATE TABLE conversation_summaries (
          conversation_id TEXT PRIMARY KEY,
          title TEXT NOT NULL DEFAULT '',
          preview TEXT NOT NULL DEFAULT '',
          step_count INTEGER NOT NULL DEFAULT 0,
          last_modified_time DATETIME NOT NULL,
          workspace_uris TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT '',
          parent_conversation_id TEXT NOT NULL DEFAULT '',
          nesting_depth INTEGER NOT NULL DEFAULT 0,
          not_fully_idle NUMERIC NOT NULL DEFAULT 0,
          killed NUMERIC NOT NULL DEFAULT 0
        );
      `);

      const topIdleId = "11111111-2222-3333-4444-555555555555";
      const topRunningId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const childSubagentId = "99999999-8888-7777-6666-555555555555";
      const killedId = "77777777-6666-5555-4444-333333333333";

      const insert = db.query(`
        INSERT INTO conversation_summaries(
          conversation_id, title, preview, step_count, last_modified_time,
          workspace_uris, status, parent_conversation_id, nesting_depth, not_fully_idle, killed
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `);

      insert.run(
        topIdleId,
        "Desktop Session Idle",
        "Preview 1",
        4,
        "2026-11-09T06:00:00Z",
        JSON.stringify([`file://${root}/proj-a`]),
        "CASCADE_RUN_STATUS_IDLE",
        "",
        0,
        0,
        0
      );
      insert.run(
        topRunningId,
        "Desktop Session Running",
        "Preview 2",
        2,
        "2026-11-09T07:00:00Z",
        JSON.stringify(["file:///unrelated/path"]),
        "CASCADE_RUN_STATUS_RUNNING",
        "",
        0,
        1,
        0
      );
      // Subagent should be filtered out
      insert.run(
        childSubagentId,
        "Subagent Research",
        "Sub",
        3,
        "2026-11-09T07:30:00Z",
        "[]",
        "CASCADE_RUN_STATUS_IDLE",
        topIdleId,
        1,
        0,
        0
      );
      // Killed session should be filtered out
      insert.run(
        killedId,
        "Killed Session",
        "Killed",
        1,
        "2026-11-09T07:40:00Z",
        "[]",
        "CASCADE_RUN_STATUS_IDLE",
        "",
        0,
        0,
        1
      );
      db.close();

      const projDir = path.join(root, "proj-a");
      mkdirSync(projDir, { recursive: true });

      const logsDir = path.join(root, "brain", topIdleId, ".system_generated", "logs");
      mkdirSync(logsDir, { recursive: true });

      writeFileSync(
        path.join(logsDir, "transcript.jsonl"),
        [
          JSON.stringify({
            step_index: 0,
            type: "USER_INPUT",
            status: "DONE",
            created_at: "2026-11-09T05:59:00Z",
            content: "<USER_REQUEST>\nHelp me inspect ACP\n</USER_REQUEST>",
          }),
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-09T06:00:00Z",
            content: "truncated...",
            truncated_fields: ["content"],
            tool_calls: [{ name: "read_file", args: { Path: "/tmp/a" } }],
          }),
        ].join("\n") + "\n"
      );

      writeFileSync(
        path.join(logsDir, "transcript_full.jsonl"),
        [
          JSON.stringify({
            step_index: 0,
            type: "USER_INPUT",
            status: "DONE",
            created_at: "2026-11-09T05:59:00Z",
            content: "<USER_REQUEST>\nHelp me inspect ACP\n</USER_REQUEST>",
          }),
          JSON.stringify({
            step_index: 1,
            type: "PLANNER_RESPONSE",
            status: "DONE",
            created_at: "2026-11-09T06:00:00Z",
            content: "Full hydrated answer from transcript_full.jsonl",
            tool_calls: [{ name: "read_file", args: { Path: "/tmp/a" } }],
          }),
        ].join("\n") + "\n"
      );

      const reader = new AntigravityDesktopReader({
        desktopAppDataDir: root,
        getAllowedProjects: () => [{ id: "proj-a", name: "Project A", rootPath: projDir }],
      });

      const sessions = reader.listSessions();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toMatchObject({
        source: "antigravity",
        id: topRunningId,
        title: "Desktop Session Running",
        projectId: null,
        state: "running",
        sendEnabled: false,
        creationClient: { kind: "desktop", evidence: "explicit" },
      });
      expect(sessions[1]).toMatchObject({
        source: "antigravity",
        id: topIdleId,
        title: "Desktop Session Idle",
        projectId: "proj-a",
        state: "idle",
        sendEnabled: false,
        creationClient: { kind: "desktop", evidence: "explicit" },
      });

      const history = reader.readHistory(topIdleId);
      expect(history?.messages).toEqual([
        {
          id: "step-0-user",
          role: "user",
          text: "Help me inspect ACP",
          createdAt: Date.parse("2026-11-09T05:59:00Z"),
        },
        {
          id: "step-1-assistant",
          role: "assistant",
          text: "Full hydrated answer from transcript_full.jsonl",
          createdAt: Date.parse("2026-11-09T06:00:00Z"),
        },
      ]);
      expect(history?.activeTurnItems).toEqual([
        {
          kind: "tool",
          text: "read_file",
        },
      ]);

      // Rejects traversal or non-UUID conversation_id
      expect(reader.readHistory("../etc/passwd")).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
