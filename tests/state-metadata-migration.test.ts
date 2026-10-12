import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../src/state/db.ts";

test("StateDb upgrades existing metadata tables idempotently", () => {
  const root = mkdtempSync(join(tmpdir(), "sea-bridge-metadata-migration-"));
  const path = join(root, "state.sqlite");
  const legacy = new Database(path);
  legacy.exec(`
    CREATE TABLE observed_sessions (
      session_id TEXT PRIMARY KEY, turn_id TEXT, last_event TEXT NOT NULL,
      activity_state TEXT NOT NULL, last_seen_at INTEGER NOT NULL, transcript_path TEXT, cwd TEXT
    );
    CREATE TABLE desktop_codex_catalog (
      thread_id TEXT PRIMARY KEY, title TEXT NOT NULL, rollout_path TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, recency_at_ms INTEGER,
      creation_client_kind TEXT NOT NULL, creation_client_evidence TEXT NOT NULL,
      observed_at INTEGER NOT NULL, missing_count INTEGER NOT NULL DEFAULT 0
    );
  `);
  legacy.close();

  try {
    for (let pass = 0; pass < 2; pass++) {
      const state = new StateDb(path);
      const observed = state.db.query("PRAGMA table_info(observed_sessions)").all() as Array<{ name: string }>;
      const catalog = state.db.query("PRAGMA table_info(desktop_codex_catalog)").all() as Array<{ name: string }>;
      expect(observed.map((item) => item.name)).toEqual(expect.arrayContaining(["model", "permission_mode", "metadata_observed_at"]));
      expect(catalog.map((item) => item.name)).toEqual(expect.arrayContaining(["model", "reasoning_effort"]));
      state.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
