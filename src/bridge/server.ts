import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { LocalBridgeService } from "./service.ts";
import { asRecord, LocalBridgeError } from "./types.ts";

const BRIDGE_MAX_BYTES = 256 * 1024;

/** Stream and parse a bounded JSON object body without trusting Content-Length. */
async function readJsonBody(request: Request, allowEmpty = false): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) {
    if (allowEmpty) return {};
    throw new LocalBridgeError(400, "body_required");
  }
  if (!request.headers.get("content-type")?.split(";")[0]?.trim().startsWith("application/json")) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (allowEmpty) return {};
    throw new LocalBridgeError(415, "json_required");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > BRIDGE_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new LocalBridgeError(413, "body_too_large");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) {
    if (allowEmpty) return {};
    throw new LocalBridgeError(400, "body_required");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new LocalBridgeError(400, "invalid_json");
  }
  return asRecord(parsed);
}

/** Verify a stale Unix socket is unowned and refused before unlinking its exact inode. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  const stat = lstatSync(socketPath);
  if (!stat.isSocket() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new LocalBridgeError(503, "unsafe_socket_path");
  }
  await new Promise<void>((resolve, reject) => {
    const probe = connect(socketPath);
    probe.setTimeout(500, () => {
      probe.destroy();
      reject(new LocalBridgeError(503, "socket_probe_timeout"));
    });
    probe.once("connect", () => {
      probe.destroy();
      reject(new LocalBridgeError(503, "socket_in_use"));
    });
    probe.once("error", (err: NodeJS.ErrnoException) => {
      probe.destroy();
      if (err.code === "ECONNREFUSED") resolve();
      else reject(new LocalBridgeError(503, "socket_probe_failed"));
    });
  });
  const current = lstatSync(socketPath);
  if (current.ino !== stat.ino || current.dev !== stat.dev) {
    throw new LocalBridgeError(503, "socket_changed");
  }
  unlinkSync(socketPath);
}

/** Build the HTTP request handler served exclusively over the private Unix Domain Socket. */
export function createLocalBridgeHandler(service: LocalBridgeService): (request: Request) => Promise<Response> {
  const json = (payload: unknown, status = 200): Response =>
    Response.json(payload, {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });

  return async (request: Request): Promise<Response> => {
    try {
      if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
        throw new LocalBridgeError(403, "browser_not_allowed");
      }
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method;

      if (path === "/v1/health" && method === "GET") {
        return json(service.health());
      }
      if (path === "/v1/auth/login" && method === "POST") {
        return json(await service.login(await readJsonBody(request)));
      }
      if (path === "/v1/auth/verify" && method === "POST") {
        return json(service.verify(await readJsonBody(request)));
      }
      if (path === "/v1/auth/logout" && method === "POST") {
        return json(service.logout(await readJsonBody(request)));
      }
      if (path === "/v1/catalog" && method === "GET") {
        return json(await service.catalog());
      }
      if (path === "/v1/sessions" && method === "POST") {
        return json(await service.createSession(await readJsonBody(request)));
      }

      const opMatch = path.match(/^\/v1\/operations\/([^/]+)$/);
      if (opMatch && method === "GET") {
        return json(await service.getOperation(decodeURIComponent(opMatch[1] ?? "")));
      }

      const desktopMatch = path.match(/^\/v1\/sessions\/codex\/([^/]+)\/open-desktop$/);
      if (desktopMatch && method === "POST") {
        return json(await service.openDesktop(decodeURIComponent(desktopMatch[1] ?? "")));
      }

      const sessionAction = path.match(/^\/v1\/sessions\/(codex|antigravity|dsh)\/([^/]+)\/(messages|summary|interrupt)$/);
      if (sessionAction) {
        const sourceName = sessionAction[1] ?? "";
        const sessionId = decodeURIComponent(sessionAction[2] ?? "");
        const action = sessionAction[3];
        if (action === "summary" && method === "GET") {
          return json(await service.getSessionSummary(sourceName, sessionId));
        }
        if (action === "messages" && method === "POST") {
          return json(await service.sendMessage(sourceName, sessionId, await readJsonBody(request)));
        }
        if (action === "interrupt" && method === "POST") {
          return json(await service.interruptSession(sourceName, sessionId, await readJsonBody(request, true)));
        }
      }

      throw new LocalBridgeError(404, "not_found");
    } catch (error) {
      if (error instanceof LocalBridgeError) {
        return json({ errorCode: error.errorCode }, error.status);
      }
      return json({ errorCode: "bridge_internal_error" }, 503);
    }
  };
}

/** Private Unix Domain Socket server (`0700` parent directory, `0600` socket file) for trusted local callers. */
export class LocalBridgeServer {
  private server: Bun.Server<undefined> | null = null;
  private socketInode: number | null = null;

  /** Bind to a local filesystem socket path verified against symlink and permission attacks. */
  constructor(
    private readonly socketPath: string,
    private readonly service: LocalBridgeService,
  ) {}

  /** Validate parent directory ownership/mode, clear any stale socket, and listen with `0600` permissions. */
  async start(): Promise<void> {
    if (this.socketPath.length > 100) {
      throw new LocalBridgeError(503, "socket_path_too_long");
    }
    const parent = dirname(this.socketPath);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const parentStat = lstatSync(parent);
    if (
      parentStat.isSymbolicLink() ||
      !parentStat.isDirectory() ||
      (parentStat.mode & 0o077) !== 0 ||
      (process.getuid && parentStat.uid !== process.getuid())
    ) {
      throw new LocalBridgeError(503, "private_socket_directory_required");
    }

    await removeStaleSocket(this.socketPath);
    this.server = Bun.serve({
      unix: this.socketPath,
      maxRequestBodySize: BRIDGE_MAX_BYTES,
      fetch: createLocalBridgeHandler(this.service),
    });
    chmodSync(this.socketPath, 0o600);
    this.socketInode = lstatSync(this.socketPath).ino;
  }

  /** Drain active connections and unlink the socket only if its inode still belongs to this instance. */
  async stop(): Promise<void> {
    const active = this.server;
    this.server = null;
    await active?.stop(true);
    if (this.socketInode !== null && existsSync(this.socketPath)) {
      try {
        if (lstatSync(this.socketPath).ino === this.socketInode) {
          unlinkSync(this.socketPath);
        }
      } catch {
        // Ignore concurrent cleanup races during shutdown.
      }
    }
    this.socketInode = null;
  }
}
