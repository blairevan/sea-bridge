import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth, classifyRequest } from "../src/web/auth.ts";

/** Build isolated auth with an injectable clock and no real credentials. */
function setup() {
  const db = new Database(":memory:"); migrateWeb(db);
  let now = 1000;
  const store = new WebStore(db);
  return { db, store, auth: new WebAuth(store, () => now), advance: (ms: number) => { now += ms; } };
}

describe("Web pairing", () => {
  test("eight-digit code is memory-only, one-time, expiring, and restart-invalidated", () => {
    const { db, store, auth, advance } = setup();
    try {
      const first = auth.createPairCode(); expect(first.code).toMatch(/^\d{8}$/);
      expect(first.expiresAt).toBe(301000);
      expect(JSON.stringify(db.query("SELECT name FROM sqlite_master").all())).not.toContain("pair_code");
      const second = auth.createPairCode();
      if (first.code !== second.code) expect(auth.pair(first.code, "local", "test")).toBeNull();
      const paired = auth.pair(second.code, "local", "test"); expect(paired).not.toBeNull();
      expect(auth.pair(second.code, "local", "test")).toBeNull();
      expect(JSON.stringify(db.query("SELECT * FROM web_device_sessions").all())).not.toContain(paired?.sessionToken ?? "unexpected");
      expect(auth.authenticate(paired?.sessionToken ?? "")?.name).toBe("test");
      expect(auth.verifyCsrf(paired?.device.id ?? "", paired?.csrfToken ?? "", paired?.csrfToken ?? "")).toBe(true);
      expect(auth.verifyCsrf(paired?.device.id ?? "", paired?.csrfToken ?? "", "wrong")).toBe(false);
      const third = auth.createPairCode(); advance(300000);
      expect(auth.pair(third.code, "local", "test")).toBeNull();
      const fourth = auth.createPairCode();
      expect(new WebAuth(store).pair(fourth.code, "local", "test")).toBeNull();
      advance(30 * 86400000);
      expect(auth.authenticate(paired?.sessionToken ?? "")).toBeNull();
    } finally { db.close(); }
  });

  test("limits per bucket and invalidates after ten wrong guesses", () => {
    const { db, auth, advance } = setup();
    try {
      const pair = auth.createPairCode();
      const wrong = pair.code === "00000000" ? "11111111" : "00000000";
      for (let i = 0; i < 5; i++) expect(auth.pair(wrong, "same", "test")).toBeNull();
      expect(auth.pair(pair.code, "same", "test")).toBeNull();
      advance(60001);
      for (let i = 0; i < 5; i++) expect(auth.pair(wrong, "other", "test")).toBeNull();
      expect(auth.pair(pair.code, "new", "test")).toBeNull();
    } finally { db.close(); }
  });

  test("global failure ceiling survives fresh code generation until its window expires", () => {
    const { db, auth, advance } = setup();
    try {
      for (let i = 0; i < 30; i++) {
        const code = auth.createPairCode().code;
        const wrong = code === "00000000" ? "11111111" : "00000000";
        expect(auth.pair(wrong, "bucket" + i, "test")).toBeNull();
      }
      const code = auth.createPairCode().code;
      expect(auth.pair(code, "fresh", "test")).toBeNull();
      advance(60001);
      expect(auth.pair(code, "fresh", "test")).not.toBeNull();
    } finally { db.close(); }
  });

  test("revocation blocks session and CSRF immediately", () => {
    const { db, store, auth } = setup();
    try {
      const paired = auth.pair(auth.createPairCode().code, "local", "test");
      if (!paired) throw new Error("fixture pairing failed");
      store.revokeDevice(paired.device.id, 1001);
      expect(auth.authenticate(paired.sessionToken)).toBeNull();
      expect(auth.verifyCsrf(paired.device.id, paired.csrfToken, paired.csrfToken)).toBe(false);
      expect(auth.cookies(paired, true).every((cookie) => cookie.includes("Secure"))).toBe(true);
      expect(auth.cookies(paired, false)[0]).toContain("HttpOnly; SameSite=Strict");
      expect(auth.cookies(paired, false)[0]).not.toContain("Domain=");
    } finally { db.close(); }
  });
});

describe("request trust", () => {
  test("exact host/origin and loopback peer are required, forwarded headers grant nothing", () => {
    const options = { port: 7310, remoteOrigin: "https://machine.example.test", peer: "127.0.0.1" };
    expect(classifyRequest(new Request("http://127.0.0.1:7310/", { headers: { Origin: "http://127.0.0.1:7310" } }), options, true)?.remote).toBe(false);
    expect(classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://machine.example.test" } }), options, true)?.remote).toBe(true);
    expect(classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://evil.test", "X-Forwarded-Host": "machine.example.test" } }), options, true)).toBeNull();
    expect(classifyRequest(new Request("http://evil.test/", { headers: { "X-Forwarded-Host": "machine.example.test" } }), options, false)).toBeNull();
    expect(classifyRequest(new Request("https://machine.example.test/"), { ...options, peer: "100.1.2.3" }, false)).toBeNull();
  });
});
