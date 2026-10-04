import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth, classifyRequest } from "../src/web/auth.ts";
import { LOGIN_FIXTURE, LOGIN_HASH, loginFixture } from "./helpers/web-login.ts";

/** Isolate persisted credentials and inject time for rate and expiry checks. */
function setup() {
  const db = new Database(":memory:"); migrateWeb(db);
  let now = 1000;
  const store = new WebStore(db);
  return { db, store, auth: new WebAuth(store, () => now), advance: (ms: number) => { now += ms; } };
}

describe("Web password login", () => {
  test("fails closed without an account; salted hashes survive restart and sessions expire", async () => {
    const { db, store, auth, advance } = setup();
    try {
      expect(await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "local", "test")).toBeNull();
      const session = await loginFixture(auth, "test");
      expect(auth.authenticate(session.sessionToken)?.name).toBe("test");
      expect(JSON.stringify(db.query("SELECT * FROM web_admin_account").all())).not.toContain(LOGIN_FIXTURE.password);
      expect(JSON.stringify(db.query("SELECT * FROM web_device_sessions").all())).not.toContain(session.sessionToken);
      expect(await new WebAuth(store).login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "local", "restart")).not.toBeNull();
      expect(auth.verifyCsrf(session.device.id, session.csrfToken, session.csrfToken)).toBe(true);
      expect(auth.verifyCsrf(session.device.id, session.csrfToken, "wrong")).toBe(false);
      advance(30 * 86400000);
      expect(auth.authenticate(session.sessionToken)).toBeNull();
    } finally { db.close(); }
  });

  test("caps attempts per source and globally, including concurrent attempts", async () => {
    const { db, auth, advance } = setup();
    auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);
    try {
      for (let i = 0; i < 5; i++) expect(await auth.login("unknown", LOGIN_FIXTURE.password, "same", "test")).toBeNull();
      expect(await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "same", "test")).toBeNull();
      advance(60001);
      for (let i = 0; i < 30; i++) expect(await auth.login(LOGIN_FIXTURE.username, "wrong", "bucket" + i, "test")).toBeNull();
      expect(await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "fresh", "test")).toBeNull();
      advance(60001);
      const sessions = await Promise.all(Array.from({ length: 8 }, (_, i) => auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "parallel" + i, "test")));
      expect(sessions.filter(Boolean).length).toBeLessThanOrEqual(2);
      expect(sessions.some(Boolean)).toBe(true);
    } finally { db.close(); }
  });

  test("reset revokes all sessions and refuses an in-flight old credential verification", async () => {
    const { db, auth } = setup();
    try {
      const session = await loginFixture(auth);
      const pending = auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "other", "test");
      auth.setAccount("changed-admin", LOGIN_HASH);
      expect(await pending).toBeNull();
      expect(auth.authenticate(session.sessionToken)).toBeNull();
      expect(auth.verifyCsrf(session.device.id, session.csrfToken, session.csrfToken)).toBe(false);
      expect(await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "other", "test")).toBeNull();
      expect(await auth.login("changed-admin", LOGIN_FIXTURE.password, "other", "test")).not.toBeNull();
      const passwordHash = await Bun.password.hash("changed-fixture-password", { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
      auth.setAccount("changed-admin", passwordHash);
      expect(await auth.login("changed-admin", LOGIN_FIXTURE.password, "reset", "test")).toBeNull();
      expect(await auth.login("changed-admin", "changed-fixture-password", "reset", "test")).not.toBeNull();
      expect(() => auth.setAccount("changed-admin", "plaintext")).toThrow();
    } finally { db.close(); }
  });

  test("device revocation blocks auth and cookies remain host-only", async () => {
    const { db, store, auth } = setup();
    try {
      const session = await loginFixture(auth);
      store.revokeDevice(session.device.id, 1001);
      expect(auth.authenticate(session.sessionToken)).toBeNull();
      expect(auth.cookies(session, true).every((cookie) => cookie.includes("Secure"))).toBe(true);
      expect(auth.cookies(session, false)[0]).toContain("HttpOnly; SameSite=Strict");
      expect(auth.cookies(session, false)[0]).not.toContain("Domain=");
    } finally { db.close(); }
  });
});

describe("request trust", () => {
  test("exact host/origin and loopback peer are required, forwarded headers grant nothing", () => {
    const options = { port: 7310, remoteOrigin: "https://machine.example.test", peer: "127.0.0.1" };
    expect(classifyRequest(new Request("http://127.0.0.1:7310/", { headers: { Origin: "http://127.0.0.1:7310" } }), options, true)?.remote).toBe(false);
    const alice = classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://machine.example.test", "Tailscale-User-Login": "alice@example.test" } }), options, true);
    const bob = classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://machine.example.test", "Tailscale-User-Login": "bob@example.test" } }), options, true);
    expect(alice?.remote).toBe(true); expect(alice?.bucket).toBe("remote");
    expect(bob?.bucket).toBe("remote"); expect(bob?.bucket).toBe(alice?.bucket);
    expect(classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://machine.example.test" } }), options, true)?.bucket).toBe("remote");
    expect(classifyRequest(new Request("https://machine.example.test/", { headers: { Origin: "https://evil.test", "X-Forwarded-Host": "machine.example.test", "Tailscale-User-Login": "alice@example.test" } }), options, true)).toBeNull();
    expect(classifyRequest(new Request("http://evil.test/", { headers: { "X-Forwarded-Host": "machine.example.test" } }), options, false)).toBeNull();
    expect(classifyRequest(new Request("https://machine.example.test/"), { ...options, peer: "100.1.2.3" }, false)).toBeNull();
  });
});

test("TCP Serve IP requests never trust client-supplied identity buckets", () => {
  const origin = "http://100.112.22.85:7310";
  const context = classifyRequest(new Request(origin, { headers: { Origin: origin, "Tailscale-User-Login": "spoof@example.test" } }), { port: 7310, remoteOrigin: origin, peer: "127.0.0.1" }, true);
  expect(context?.bucket).toBe("remote");
});
