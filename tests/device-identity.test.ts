import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebRedaction } from "../src/web/redaction.ts";
import { parseBrowserIdentity, resolveDeviceIdentity, createCachedEgressIpProbe } from "../src/web/device-identity.ts";
import { LOGIN_FIXTURE, LOGIN_HASH } from "./helpers/web-login.ts";

describe("device identity & egress IP resolution", () => {
  test("parses platform and browser cleanly without leaking custom hostnames from UA", () => {
    expect(parseBrowserIdentity(new Headers({
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    }))).toEqual({ platform: "macOS", browser: "Chrome" });

    expect(parseBrowserIdentity(new Headers({
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1",
    }))).toEqual({ platform: "iPhone", browser: "Mobile Safari" });

    expect(parseBrowserIdentity(new Headers({
      "sec-ch-ua-platform": '"Windows"',
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    }))).toEqual({ platform: "Windows", browser: "Edge" });
  });

  test("resolves 3-tier device name and real egress IP across Cloudflare, loopback and Tailscale", async () => {
    const remoteReq = new Request("https://code.xxone.xyz/api/auth/login", {
      headers: {
        "CF-Connecting-IP": "198.51.100.42",
        "X-Forwarded-For": "10.0.0.1",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
      },
    });
    const remoteIdentity = await resolveDeviceIdentity(remoteReq, { remote: true, peer: "127.0.0.1" }, {
      localHostName: () => "M5-Mac",
      tailscaleWhois: async () => "should-not-run",
      egressIpProbe: async () => "203.0.113.99",
    });
    expect(remoteIdentity).toEqual({ name: "macOS · Chrome", loginIp: "198.51.100.42" });

    const localReq = new Request("http://127.0.0.1:7310/api/auth/login", {
      headers: {
        "CF-Connecting-IP": "1.2.3.4",
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/18.0 Safari/605.1.15",
      },
    });
    const localIdentity = await resolveDeviceIdentity(localReq, { remote: false, peer: "127.0.0.1" }, {
      localHostName: () => "M5-MacBook",
      egressIpProbe: async () => "203.0.113.88",
    });
    expect(localIdentity).toEqual({ name: "M5-MacBook · Safari", loginIp: "203.0.113.88" });

    const offlineLocal = await resolveDeviceIdentity(localReq, { remote: false, peer: "127.0.0.1" }, {
      localHostName: () => "M5-MacBook",
      egressIpProbe: async () => null,
    });
    expect(offlineLocal).toEqual({ name: "M5-MacBook · Safari", loginIp: "127.0.0.1" });

    const tsReq = new Request("http://100.88.12.34:7120/api/auth/login", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/131.0.0.0 Safari/537.36",
      },
    });
    const tsIdentity = await resolveDeviceIdentity(tsReq, { remote: false, peer: "100.88.12.34" }, {
      tailscaleWhois: async (ip) => ip === "100.88.12.34" ? "mac-mini" : null,
      egressIpProbe: async () => "203.0.113.88",
    });
    expect(tsIdentity).toEqual({ name: "mac-mini · Chrome", loginIp: "203.0.113.88" });
  });

  test("caches public egress IP probe and degrades gracefully on failure", async () => {
    let calls = 0;
    let now = 1000;
    const probe = createCachedEgressIpProbe(async () => {
      calls++;
      return "ip=198.51.100.9\nts=123\n";
    }, () => now);
    expect(await probe()).toBe("198.51.100.9");
    expect(await probe()).toBe("198.51.100.9");
    expect(calls).toBe(1);
    now += 61_000;
    expect(await probe()).toBe("198.51.100.9");
    expect(calls).toBe(2);
  });

  test("migration v4 persists loginIp and clientApp and exempts loginIp from display IP redaction", async () => {
    const db = new Database(":memory:");
    migrateWeb(db);
    const store = new WebStore(db);
    const auth = new WebAuth(store);
    auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);

    try {
      const session = await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "remote", "macOS · Chrome", {
        loginIp: "198.51.100.24",
        clientApp: "toolhub",
      });
      expect(session).not.toBeNull();
      expect(session?.device.loginIp).toBe("198.51.100.24");
      expect(session?.device.clientApp).toBe("toolhub");

      const redaction = new WebRedaction([]);
      const filtered = redaction.display({
        items: store.listDevices(),
        note: "ordinary text ip 198.51.100.24 should still be masked",
      }, { redactionEnabled: true, version: 1 });
      expect(filtered.items[0]?.loginIp).toBe("198.51.100.24");
      expect(filtered.items[0]?.clientApp).toBe("toolhub");
      expect(filtered.note).toContain("[IP]");
    } finally {
      db.close();
    }
  });
});
