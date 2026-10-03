import type { WebStore } from "./store.ts";
import { WebAuth, classifyRequest } from "./auth.ts";
import type { WebRedaction } from "./redaction.ts";
import type { WebEvents } from "./events.ts";
import { createStatusService, type TelegramStatus } from "./status.ts";
import { dispatchWebOperation } from "./operations.ts";
import { operationRecords, withSessionTitles } from "./records.ts";
import type { WebSource, ExecutionEvidence } from "./sources/types.ts";

export const WEB_MAX_REQUEST_BYTES = 256 * 1024;

/** Explicit handler dependencies make authentication/dispatch ordering independently testable. */
export interface WebHttpDependencies {
  store: WebStore; auth: WebAuth; events: WebEvents; redaction: WebRedaction; pepper: Uint8Array;
  sources: Partial<Record<"codex" | "dsh", WebSource>>;
  port: number; remoteOrigin: string | null; telegramStatus: () => TelegramStatus;
}

/** Stable HTTP failures contain only allowlisted codes. */
class HttpError extends Error {
  /** Pair stable machine code with a response status. */
  constructor(readonly status: number, code: string) { super(code); }
}

/** Read body chunks up to the fixed limit without trusting Content-Length. */
async function readJson(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") throw new HttpError(415, "json_required");
  const reader = request.body?.getReader(); if (!reader) throw new HttpError(400, "body_required");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) { await reader.cancel(); throw new HttpError(413, "body_too_large"); }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new HttpError(400, "invalid_json"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "invalid_body");
  return value as Record<string, unknown>;
}

/** Extract bounded strings and reject unsupported types at the request boundary. */
function text(value: unknown, max: number, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max || /\u0000/.test(value)) throw new HttpError(400, "invalid_field");
  return value;
}

/** Parse browser cookies conservatively, rejecting duplicate credential names. */
function cookies(request: Request): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const index = item.indexOf("="); if (index < 0) continue;
    const key = item.slice(0, index).trim();
    if (key in result) throw new HttpError(400, "duplicate_cookie");
    result[key] = item.slice(index + 1).trim();
  }
  return result;
}

/** Clamp page size and validate a bounded numeric continuation offset. */
function pagination(url: URL): { limit: number; offset: number } {
  const rawLimit = url.searchParams.get("limit") ?? "30"; const rawCursor = url.searchParams.get("cursor") ?? "0";
  if (!/^\d{1,8}$/.test(rawLimit) || !/^\d{1,8}$/.test(rawCursor)) throw new HttpError(400, "invalid_cursor");
  const offset = Number(rawCursor); if (offset > 10000) throw new HttpError(400, "invalid_cursor");
  return { limit: Math.max(1, Math.min(100, Number(rawLimit))), offset };
}

/** Build the authenticated same-origin API; static assets are served by the server layer. */
export function createWebHandler(deps: WebHttpDependencies): (request: Request, peer: string) => Promise<Response> {
  const status = createStatusService(deps.sources, deps.telegramStatus);
  /** Handle one request using stable errors and a single display-policy snapshot. */
  return async (request, peer) => {
    let authenticated = false;
    /** Filter each dynamic response once, including safe settings-version metadata. */
    const json = (data: unknown, code = 200): Response => {
      const settings = deps.store.getSettings();
      const payload = authenticated ? deps.redaction.response(data, settings) : { data };
      return Response.json(payload, { status: code, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
        ...(authenticated ? { "X-Sea-Bridge-Settings-Version": String(settings.version) } : {}) } });
    };
    try {
      const url = new URL(request.url); const path = url.pathname; const method = request.method;
      const write = !["GET", "HEAD"].includes(method);
      const context = classifyRequest(request, { port: deps.port, remoteOrigin: deps.remoteOrigin, peer }, write);
      if (!context) throw new HttpError(403, "origin_denied");
      if (url.searchParams.has("token") || url.searchParams.has("sessionToken")) throw new HttpError(400, "url_credential_denied");
      if (path === "/api/auth/pair" && method === "POST") {
        const body = await readJson(request, 1024);
        const paired = deps.auth.pair(text(body.code, 8) ?? "", context.bucket, deps.redaction.storage(text(body.name, 80, true) ?? "设备"));
        if (!paired) throw new HttpError(401, "pair_failed");
        const response = json({ paired: true });
        for (const cookie of deps.auth.cookies(paired, context.origin.startsWith("https://"))) response.headers.append("Set-Cookie", cookie);
        return response;
      }
      const cookie = cookies(request); const device = deps.auth.authenticate(cookie.sea_session ?? "");
      if (!device) throw new HttpError(401, "unauthorized"); authenticated = true;
      if (write && !deps.auth.verifyCsrf(device.id, cookie.sea_csrf ?? "", request.headers.get("X-Sea-Bridge-CSRF") ?? "")) throw new HttpError(403, "csrf_denied");
      /** Revalidate after asynchronous body upload before admitting a durable write. */
      const readAuthorizedJson = async (maxBytes: number): Promise<Record<string, unknown>> => {
        const body = await readJson(request, maxBytes);
        if (!deps.auth.authenticate(cookie.sea_session ?? "")) throw new HttpError(401, "unauthorized");
        if (!deps.auth.verifyCsrf(device.id, cookie.sea_csrf ?? "", request.headers.get("X-Sea-Bridge-CSRF") ?? "")) throw new HttpError(403, "csrf_denied");
        return body;
      };
      if (path === "/api/auth/session" && method === "GET") return json({ device, settings: deps.store.getSettings() });
      if (path === "/api/auth/logout" && method === "POST") {
        deps.store.revokeDevice(device.id, Date.now()); deps.events.revoke(device.id);
        const response = json({ loggedOut: true });
        for (const name of ["sea_session", "sea_csrf"]) response.headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; SameSite=Strict${context.origin.startsWith("https://") ? "; Secure" : ""}`);
        return response;
      }
      if (path === "/api/settings" && method === "GET") return json(deps.store.getSettings());
      if (path === "/api/settings/redaction" && method === "PUT") {
        const body = await readAuthorizedJson(1024);
        if (typeof body.enabled !== "boolean" || !Number.isSafeInteger(body.expectedVersion)) throw new HttpError(400, "invalid_setting");
        const settings = deps.store.setRedaction(body.enabled, Number(body.expectedVersion), device.id, Date.now());
        if (!settings) throw new HttpError(409, "settings_conflict");
        deps.events.settingsChanged(settings.version); return json(settings);
      }
      if (path === "/api/devices" && method === "GET") return json({ items: deps.store.listDevices(), currentDeviceId: device.id });
      if (path.startsWith("/api/devices/") && method === "DELETE") {
        const id = text(decodeURIComponent(path.slice(13)), 100) ?? "";
        deps.store.revokeDevice(id, Date.now()); deps.events.revoke(id);
        deps.store.audit(device.id, "device_revoked", JSON.stringify({ id }), Date.now()); return json({ revoked: true });
      }
      if (path === "/api/events" && method === "GET") return new Response(deps.events.open(device.id, request.signal), { headers: {
        "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Sea-Bridge-Settings-Version": String(deps.store.getSettings().version),
      } });
      if (path === "/api/status" && method === "GET") return json(await status());
      const selected = url.searchParams.get("source");
      if (selected && selected !== "codex" && selected !== "dsh") throw new HttpError(400, "invalid_source");
      const catalog = path.match(/^\/api\/sources\/(codex|dsh)\/(projects|models)$/);
      if (catalog && method === "GET") {
        const source = deps.sources[catalog[1] as "codex" | "dsh"]; if (!source) throw new HttpError(503, "source_unavailable");
        return json({ items: (catalog[2] === "projects" ? await source.projects() : await source.models()).slice(0, 2000) });
      }
      if (path === "/api/sessions" && method === "GET") {
        const { limit, offset } = pagination(url); const query = url.searchParams.get("q") ?? "";
        if (query.length > 200) throw new HttpError(400, "query_too_long");
        const activity = url.searchParams.get("activity");
        if (activity && !["running", "waiting_external_approval", "unknown"].includes(activity)) throw new HttpError(400, "invalid_activity");
        const results = await Promise.allSettled(Object.entries(deps.sources).filter(([name]) => !selected || name === selected).map(async ([, source]) => source?.sessions() ?? []));
        const items = results.flatMap((result) => result.status === "fulfilled" ? result.value : []).filter((item) => item.title.toLowerCase().includes(query.toLowerCase()) && (!activity || item.state === activity)).sort((a, b) => b.updatedAt - a.updatedAt);
        return json({ items: items.slice(offset, offset + limit), cursor: items.length > offset + limit ? String(offset + limit) : null, partial: results.some((result) => result.status === "rejected"), capabilities: Object.fromEntries(Object.entries(deps.sources).map(([name, source]) => [name, source?.capabilities()])) });
      }
      const history = path.match(/^\/api\/sessions\/(codex|dsh)\/([^/]+)\/history$/);
      if (history && method === "GET") {
        const source = deps.sources[history[1] as "codex" | "dsh"]; if (!source) throw new HttpError(503, "source_unavailable");
        const id = text(decodeURIComponent(history[2] ?? ""), 200) ?? "";
        const cursor = url.searchParams.get("cursor"); if (cursor && cursor.length > 100) throw new HttpError(400, "invalid_cursor");
        const rawLimit = url.searchParams.get("limit") ?? "30";
        if (!/^\d{1,8}$/.test(rawLimit)) throw new HttpError(400, "invalid_limit");
        return json(await source.history(id, cursor, Math.max(1, Math.min(100, Number(rawLimit)))));
      }
      if (path === "/api/operations" && method === "GET") {
        const { limit, offset } = pagination(url); const session = url.searchParams.get("sessionId"); const state = url.searchParams.get("status");
        if (session && session.length > 200) throw new HttpError(400, "invalid_session");
        if (state && !["received", "dispatching", "queued", "accepted", "failed", "delivery_unknown"].includes(state)) throw new HttpError(400, "invalid_state");
        const from = url.searchParams.get("from"); const to = url.searchParams.get("to");
        if ((from && !/^\d{1,16}$/.test(from)) || (to && !/^\d{1,16}$/.test(to))) throw new HttpError(400, "invalid_date");
        return json(await withSessionTitles(operationRecords(deps.store, { source: selected, session, state, from: from ? Number(from) : 0, to: to ? Number(to) : Number.MAX_SAFE_INTEGER, limit, offset }), deps.sources));
      }
      if (path === "/api/logs" && method === "GET") {
        const { limit, offset } = pagination(url);
        return json({ items: deps.store.db.query("SELECT level,event,fields_json AS fields,created_at AS createdAt FROM web_logs ORDER BY created_at DESC LIMIT ? OFFSET ?").all(limit, offset) });
      }
      if (path.startsWith("/api/operations/") && method === "GET") {
        const id = text(decodeURIComponent(path.slice(16)), 36) ?? "";
        const operation = deps.store.getOperation(id);
        if (!operation) throw new HttpError(404, "operation_not_received");
        let execution: ExecutionEvidence = { state: "unknown", exact: false };
        if (operation.sessionId && ["queued", "accepted", "delivery_unknown"].includes(operation.state)) {
          const source = deps.sources[operation.source];
          if (source?.execution) {
            try { execution = await source.execution(operation.sessionId, operation.turnId, operation.createdAt); }
            catch { execution = { state: "unknown", exact: false }; }
          }
        }
        return json({ ...operation, execution });
      }
      const send = path.match(/^\/api\/sessions\/(codex|dsh)\/([^/]+)\/messages$/);
      if (method === "POST" && (path === "/api/sessions" || send)) {
        const body = await readAuthorizedJson(WEB_MAX_REQUEST_BYTES);
        const executionSource = send?.[1] ?? body.source;
        if (executionSource !== "codex" && executionSource !== "dsh") throw new HttpError(400, "invalid_source");
        const source = deps.sources[executionSource]; if (!source) throw new HttpError(503, "source_unavailable");
        const operationId = text(body.operationId, 36) ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId)) throw new HttpError(400, "invalid_operation_id");
        const operation = await dispatchWebOperation({ operationId, source: executionSource, kind: send ? "send" : "create",
          targetId: send ? text(decodeURIComponent(send[2] ?? ""), 200) : null,
          projectId: send ? null : text(body.projectId, 200), modelId: send ? null : text(body.modelId, 2000, true), prompt: text(body.prompt, 32000) ?? "",
        }, device.id, source, deps.store, deps.pepper, deps.redaction);
        return json(operation);
      }
      throw new HttpError(404, "not_found");
    } catch (error) {
      const code = error instanceof HttpError ? error.message : error instanceof Error && error.message === "operation_conflict" ? "operation_conflict" : "request_failed";
      const responseStatus = error instanceof HttpError ? error.status : code === "operation_conflict" ? 409 : 503;
      if (authenticated && responseStatus >= 500) {
        try { deps.store.db.query("INSERT INTO web_logs(level,event,fields_json,created_at) VALUES('warn','web_request_failed',?,?)").run(JSON.stringify({ code }), Date.now()); } catch { /* Diagnostics must not mask an operation result. */ }
      }
      return json({ errorCode: code }, responseStatus);
    }
  };
}
