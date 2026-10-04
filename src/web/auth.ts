import { randomUUID } from "node:crypto";
import { randomToken, safeEqual, tokenHash } from "./crypto.ts";
import { validUsername, validPasswordHash } from "./password.ts";
import { WebStore, type WebDevice } from "./store.ts";

/** Credentials exist only while issuing a response; persistence contains hashes. */
export interface LoggedInDevice { device: WebDevice; sessionToken: string; csrfToken: string; }
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
  // All remote attempts share a bound: forwarded identity/IP headers are not trusted.
  const bucket = remote ? "remote" : "loopback";
  return { remote, origin, bucket };
}

/** Password authentication plus durable device sessions and CSRF verification. */
export class WebAuth {
  private readonly buckets = new Map<string, { start: number; attempts: number }>();
  private global = { start: 0, attempts: 0 };
  private pending = 0;

  /** Inject time for deterministic expiry and rate-limit tests. */
  constructor(private readonly store: WebStore, private readonly now: () => number = Date.now) {}

  /** Report provisioning state only to trusted local callers. */
  accountConfigured(): boolean { return this.store.getAccount() !== null; }

  /** Install an operator-supplied hash and invalidate existing logins atomically. */
  setAccount(username: string, passwordHash: string): void {
    if (!validUsername(username) || !validPasswordHash(passwordHash)) throw new Error("web_account_invalid");
    this.store.setAccount(username, passwordHash, this.now());
    // Deliberately retain attempt counters across credential changes.
  }

  /** Reserve attempts before asynchronous verification and fence concurrent resets. */
  async login(username: string, password: string, bucket: string, name: string): Promise<LoggedInDevice | null> {
    const now = this.now();
    for (const [key, value] of this.buckets) if (now - value.start >= 60000) this.buckets.delete(key);
    if (now - this.global.start >= 60000) this.global = { start: now, attempts: 0 };
    if (this.buckets.size >= 1000 || this.global.attempts >= 30 || this.pending >= 2) return null;
    let counter = this.buckets.get(bucket);
    if (!counter) { counter = { start: now, attempts: 0 }; this.buckets.set(bucket, counter); }
    if (counter.attempts >= 5) return null;
    counter.attempts++; this.global.attempts++;
    const account = this.store.getAccount();
    if (!account || username.length > 64 || !password || password.length > 256 || /\u0000/.test(password)) return null;
    this.pending++;
    let verified = false;
    try { verified = await Bun.password.verify(password, account.passwordHash, "argon2id"); }
    catch { return null; }
    finally { this.pending--; }
    if (!verified || !safeEqual(username, account.username) || this.store.getAccount()?.revision !== account.revision) return null;
    const issuedAt = this.now();
    const sessionToken = randomToken(); const csrfToken = randomToken(); const id = randomUUID();
    const deviceName = name.trim().slice(0, 80).replace(/[\u0000-\u001f\u007f]/g, "") || "设备";
    this.store.createDevice({ id, name: deviceName, sessionHash: tokenHash(sessionToken), csrfHash: tokenHash(csrfToken), pairedAt: issuedAt, expiresAt: issuedAt + 30 * 86400000 });
    const device = this.store.findDevice(tokenHash(sessionToken), issuedAt);
    if (!device) throw new Error("web_device_creation_failed");
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
  cookies(session: LoggedInDevice, secure: boolean): string[] {
    const flags = `SameSite=Strict; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`;
    return [ `sea_session=${session.sessionToken}; HttpOnly; ${flags}`, `sea_csrf=${session.csrfToken}; ${flags}` ];
  }

}
