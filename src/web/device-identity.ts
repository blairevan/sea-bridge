import { hostname } from "node:os";
import { isIP } from "node:net";
import { spawnSync } from "node:child_process";

/** Parsed generic platform and browser family from standard HTTP headers. */
export interface BrowserIdentity {
  platform: string;
  browser: string;
}

/** Resolved session metadata stored with a paired device. */
export interface ResolvedDeviceIdentity {
  name: string;
  loginIp: string;
}

/** Injectable probes so unit tests never invoke external binaries or public endpoints. */
export interface DeviceIdentityProbes {
  localHostName?: () => string | null;
  tailscaleWhois?: (ip: string) => Promise<string | null>;
  egressIpProbe?: () => Promise<string | null>;
}

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Sanitize display labels into bounded printable text. */
function cleanLabel(value: string, fallback: string, maxLength = 80): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maxLength);
  return cleaned || fallback;
}

/** Check whether a socket peer belongs to the Tailscale CGNAT or ULA address space. */
export function isTailscalePeer(peer: string): boolean {
  const normalized = peer.startsWith("::ffff:") ? peer.slice(7) : peer;
  if (/^fd7a:115c:a1e0:/i.test(normalized)) return true;
  const parts = normalized.split(".").map(Number);
  return parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) &&
    parts[0] === 100 && (parts[1] ?? 0) >= 64 && (parts[1] ?? 0) <= 127;
}

/** Extract generic OS platform and browser family from Client Hints and User-Agent. */
export function parseBrowserIdentity(headers: Headers): BrowserIdentity {
  const ua = headers.get("user-agent") ?? "";
  const chPlatform = (headers.get("sec-ch-ua-platform") ?? "").replace(/"/g, "").trim();

  let platform = "Web";
  if (/iPhone/i.test(ua)) platform = "iPhone";
  else if (/iPad/i.test(ua)) platform = "iPad";
  else if (/Android/i.test(ua) || /^Android$/i.test(chPlatform)) platform = "Android";
  else if (/^macOS$/i.test(chPlatform) || /Macintosh|Mac OS X/i.test(ua)) platform = "macOS";
  else if (/^Windows$/i.test(chPlatform) || /Windows NT/i.test(ua)) platform = "Windows";
  else if (/^Linux$/i.test(chPlatform) || /Linux/i.test(ua)) platform = "Linux";

  let browser = "Browser";
  if (/EdgA?\//i.test(ua)) browser = "Edge";
  else if (/OPR\/|Opera/i.test(ua)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//i.test(ua)) browser = "Firefox";
  else if (/CriOS\//i.test(ua)) browser = "Mobile Chrome";
  else if (/Chrome\//i.test(ua)) browser = platform === "Android" ? "Mobile Chrome" : "Chrome";
  else if (/Safari\//i.test(ua)) browser = platform === "iPhone" || platform === "iPad" ? "Mobile Safari" : "Safari";

  return { platform, browser };
}

/** Read and cache the local machine friendly name on macOS or OS hostname fallback. */
export function createLocalHostNameReader(): () => string | null {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    if (process.platform === "darwin") {
      try {
        const out = spawnSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 1000 });
        if (out.status === 0 && out.stdout.trim()) {
          cached = cleanLabel(out.stdout.trim(), "", 48) || null;
          if (cached) return cached;
        }
      } catch { /* Fall back to standard hostname. */ }
    }
    try {
      cached = cleanLabel(hostname().replace(/\.local$/i, ""), "", 48) || null;
    } catch {
      cached = null;
    }
    return cached;
  };
}

/** Resolve a Tailscale peer IP to its registered node hostname with a strict timeout. */
export async function queryTailscaleWhois(ip: string): Promise<string | null> {
  if (!isTailscalePeer(ip)) return null;
  try {
    const proc = Bun.spawn(["tailscale", "whois", "--json", ip], { stdout: "pipe", stderr: "ignore" });
    const timer = setTimeout(() => { try { proc.kill(); } catch {} }, 1500);
    timer.unref();
    const raw = await new Response(proc.stdout).text();
    clearTimeout(timer);
    if ((await proc.exited) !== 0) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const node = (parsed as Record<string, unknown>).Node;
    if (!node || typeof node !== "object") return null;
    const record = node as Record<string, unknown>;
    const computed = typeof record.ComputedName === "string" ? record.ComputedName.trim() : "";
    const hostinfo = record.Hostinfo && typeof record.Hostinfo === "object"
      ? (record.Hostinfo as Record<string, unknown>).Hostname : undefined;
    const label = computed || (typeof hostinfo === "string" ? hostinfo.trim() : "");
    return label ? cleanLabel(label.replace(/\.local$/i, ""), "", 48) : null;
  } catch {
    return null;
  }
}

/** Create a short-cached public egress IP probe using Cloudflare trace endpoints. */
export function createCachedEgressIpProbe(
  fetchTrace: (url: string) => Promise<string> = async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500), redirect: "error" });
    if (!res.ok) throw new Error("trace_failed");
    return await res.text();
  },
  now: () => number = Date.now,
  ttlMs = 60_000,
): () => Promise<string | null> {
  let cached: { ip: string; expiresAt: number } | null = null;
  return async () => {
    const current = now();
    if (cached && cached.expiresAt > current) return cached.ip;
    for (const url of ["https://cloudflare.com/cdn-cgi/trace", "https://1.1.1.1/cdn-cgi/trace"]) {
      try {
        const text = await fetchTrace(url);
        const line = text.split(/\r?\n/).find((item) => item.startsWith("ip="));
        const ip = line ? line.slice(3).trim() : "";
        if (ip && isIP(ip) !== 0) {
          cached = { ip, expiresAt: now() + ttlMs };
          return ip;
        }
      } catch { /* Try next trace endpoint or degrade gracefully. */ }
    }
    return null;
  };
}

/** Resolve automatic device label and public egress IP according to request provenance. */
export async function resolveDeviceIdentity(
  request: Request,
  context: { remote: boolean; peer: string },
  probes: DeviceIdentityProbes = {},
): Promise<ResolvedDeviceIdentity> {
  const { platform, browser } = parseBrowserIdentity(request.headers);
  const normalizedPeer = context.peer.startsWith("::ffff:") ? context.peer.slice(7) : context.peer;

  if (context.remote) {
    const cfIp = (request.headers.get("cf-connecting-ip") ?? "").trim();
    const loginIp = cfIp && isIP(cfIp) !== 0
      ? cfIp
      : (isIP(normalizedPeer) !== 0 ? normalizedPeer : "");
    return {
      name: cleanLabel(`${platform} · ${browser}`, "Web · Browser"),
      loginIp,
    };
  }

  let hostLabel: string | null = null;
  if (isTailscalePeer(normalizedPeer) && probes.tailscaleWhois) {
    hostLabel = await probes.tailscaleWhois(normalizedPeer).catch(() => null);
  } else if (LOOPBACK_PEERS.has(context.peer) && probes.localHostName) {
    hostLabel = probes.localHostName();
  }

  const probedIp = probes.egressIpProbe ? await probes.egressIpProbe().catch(() => null) : null;
  const fallbackIp = isIP(normalizedPeer) !== 0 ? normalizedPeer : "";
  const loginIp = probedIp && isIP(probedIp) !== 0 ? probedIp : fallbackIp;

  return {
    name: cleanLabel(`${hostLabel || platform} · ${browser}`, "Web · Browser"),
    loginIp,
  };
}
