import { createHash, createHmac, randomBytes, randomInt, randomUUID } from "node:crypto";
import { randomToken, safeEqual, tokenHash } from "./crypto.ts";
import { WebStore, type WebDevice } from "./store.ts";

/** Credentials exist only while issuing a response; persistence contains hashes. */
export interface PairedDevice { device: WebDevice; sessionToken: string; csrfToken: string; }
/** Trusted request context derived from configured hosts and the observed backend peer. */
export interface RequestContext { remote: boolean; origin: string; bucket: string; }

/** Reject unconfigured hosts and cross-origin writes; forwarded headers never authorize. */
export function classifyRequest(
  request: Request,
  options: { port: number; remoteOrigin: string | null; peer: string },
  write: boolean,
): RequestContext | null {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(options.peer)) return null;
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  const localOrigins = [`http://127.0.0.1:${options.port}`, `http://localhost:${options.port}`];
  const origin = [ ...localOrigins, ...(options.remoteOrigin ? [options.remoteOrigin] : []) ]
    .find((candidate) => new URL(candidate).host === host);
  if (!origin || (write && request.headers.get("origin") !== origin)) return null;
  const remote = origin === options.remoteOrigin;
  // Tailscale Serve strips spoofed identity headers before adding its own. We only consult the
  // login after the configured remote Host and loopback backend gates above have passed, and use
  // a digest solely to keep pairing-failure buckets independent without retaining user identity.
  const tailscaleLogin = remote && origin.startsWith("https://") ? request.headers.get("Tailscale-User-Login")?.trim() : null;
  const bucket = remote
    ? tailscaleLogin ? `serve:${createHash("sha256").update(tailscaleLogin).digest("hex").slice(0, 24)}` : "serve:anonymous"
    : "loopback";
  return { remote, origin, bucket };
}

/** Memory-only pairing plus durable device authentication and CSRF verification. */
export class WebAuth {
  private readonly pairKey = randomBytes(32);
  private active: { mac: string; expiresAt: number; failures: number } | null = null;
  private readonly buckets = new Map<string, { start: number; failures: number }>();
  private global = { start: 0, failures: 0 };

  /** Inject time for deterministic expiry and rate-limit tests. */
  constructor(private readonly store: WebStore, private readonly now: () => number = Date.now) {}

  /** Replace the current one-time pairing code; never persist or log it. */
  createPairCode(): { code: string; expiresAt: number } {
    const code = randomInt(0, 100000000).toString().padStart(8, "0");
    const expiresAt = this.now() + 300000;
    this.active = { mac: this.codeMac(code), expiresAt, failures: 0 };
    return { code, expiresAt };
  }

  /** Apply bounded counters before comparing the code, returning generic failure. */
  pair(code: string, bucket: string, name: string): PairedDevice | null {
    const now = this.now();
    for (const [key, value] of this.buckets) if (now - value.start >= 60000) this.buckets.delete(key);
    if (this.buckets.size > 1000) return null;
    let counter = this.buckets.get(bucket);
    if (!counter) { counter = { start: now, failures: 0 }; this.buckets.set(bucket, counter); }
    if (now - this.global.start >= 60000) this.global = { start: now, failures: 0 };
    if (counter.failures >= 5 || this.global.failures >= 30) return null;
    const active = this.active;
    if (!active || active.expiresAt <= now || active.failures >= 10 ||
        !/^\d{8}$/.test(code) || !safeEqual(this.codeMac(code), active.mac)) {
      counter.failures++; this.global.failures++;
      if (active) { active.failures++; if (active.failures >= 10 || active.expiresAt <= now) this.active = null; }
      return null;
    }
    this.active = null;
    const sessionToken = randomToken(); const csrfToken = randomToken(); const id = randomUUID();
    const deviceName = name.trim().slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, "") || "设备";
    this.store.createDevice({ id, name: deviceName, sessionHash: tokenHash(sessionToken), csrfHash: tokenHash(csrfToken), pairedAt: now, expiresAt: now + 30 * 86400000 });
    const device = this.store.findDevice(tokenHash(sessionToken), now);
    if (!device) throw new Error("web_device_creation_failed");
    counter.failures = 0;
    return { device, sessionToken, csrfToken };
  }

  /** Resolve an unexpired, unrevoked cookie credential. */
  authenticate(token: string): WebDevice | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const device = this.store.findDevice(tokenHash(token), this.now());
    if (device) this.store.touchDevice(device.id, this.now());
    return device;
  }

  /** Require matching double-submit values bound to the active device session. */
  verifyCsrf(deviceId: string, cookie: string, header: string): boolean {
    return /^[A-Za-z0-9_-]{43}$/.test(cookie) && safeEqual(cookie, header) && this.store.verifyCsrf(deviceId, tokenHash(header), this.now());
  }

  /** Emit host-only cookies; remote HTTPS always adds Secure. */
  cookies(paired: PairedDevice, secure: boolean): string[] {
    const flags = `SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
    return [ `sea_session=${paired.sessionToken}; HttpOnly; ${flags}`, `sea_csrf=${paired.csrfToken}; ${flags}` ];
  }

  /** MAC low-entropy codes with a process-only random key. */
  private codeMac(code: string): string { return createHmac("sha256", this.pairKey).update(code).digest("hex"); }
}
