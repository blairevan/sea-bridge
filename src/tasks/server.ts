import { chmodSync, existsSync, lstatSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { connect } from 'node:net';
import { APP_VERSION } from '../web/version.ts';
import { TaskBridgeError, field, record } from './contract.ts';
import type { TaskConversationService } from './conversation-service.ts';

/** Bound private request bodies without trusting Content-Length. */
async function body(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new TaskBridgeError('json_required', 415);
  const reader = request.body?.getReader(); if (!reader) throw new TaskBridgeError('body_required');
  const chunks: Uint8Array[] = []; let count = 0;
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break;
      count += chunk.value.byteLength; if (count > 65536) throw new TaskBridgeError('body_too_large', 413); chunks.push(chunk.value); }
    const bytes = new Uint8Array(count); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return record(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Task ingress is never reachable through public Web routing or origin-based browser calls. */
export function taskBridgeHandler(service: TaskConversationService): (request: Request) => Promise<Response> {
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  return async request => {
    try {
      if (request.headers.has('origin') || request.headers.has('sec-fetch-site')) throw new TaskBridgeError('browser_not_allowed', 403);
      const url = new URL(request.url);
      if (url.pathname === '/v1/health' && request.method === 'GET') return json({ ready: true, protocol: 1, version: APP_VERSION, instanceId: service.store.instanceId });
      if (url.pathname === '/v1/turns' && request.method === 'POST') return json(service.submit(await body(request)), 202);
      const match = url.pathname.match(/^\/v1\/operations\/([a-zA-Z0-9_-]+)(?:\/(interrupt|release|guard|open|reconcile))?$/);
      if (!match) throw new TaskBridgeError('not_found', 404);
      const id = match[1]!;
      if (!match[2] && request.method === 'GET') return json(service.get(id));
      if (request.method !== 'POST') throw new TaskBridgeError('not_found', 404);
      const data = await body(request);
      if (match[2] === 'interrupt') return json(await service.interrupt(id, field(data.turnId)));
      if (match[2] === 'release') return json(await service.release(id));
      if (match[2] === 'guard') return json(await service.guard(id));
      if (match[2] === 'reconcile') return json(await service.reconcile(id));
      if (match[2] === 'open') { await service.open(id); return json({ requested: true }); }
      throw new TaskBridgeError('not_found', 404);
    } catch (error) {
      return json({ error: error instanceof TaskBridgeError ? error.message : 'task_bridge_unavailable' }, error instanceof TaskBridgeError ? error.status : 503);
    }
  };
}

/** A stale socket may be removed only after ownership, inode and a negative connection probe agree. */
async function removeStale(path: string): Promise<void> {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isSocket() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new TaskBridgeError('unsafe_socket_path', 503);
  await new Promise<void>((resolve, reject) => {
    const client = connect(path);
    client.setTimeout(500, () => { client.destroy(); reject(new TaskBridgeError('socket_probe_unknown', 503)); });
    client.once('connect', () => { client.destroy(); reject(new TaskBridgeError('socket_in_use', 503)); });
    client.once('error', (error: NodeJS.ErrnoException) => { client.destroy(); error.code === 'ECONNREFUSED' ? resolve() : reject(new TaskBridgeError('socket_probe_failed', 503)); });
  });
  const current = lstatSync(path);
  if (current.ino !== stat.ino || current.dev !== stat.dev) throw new TaskBridgeError('socket_changed', 503);
  unlinkSync(path);
}

/** Bind a filesystem-authenticated service socket without touching browser credentials. */
export async function startTaskBridge(path: string, service: TaskConversationService) {
  const parent = dirname(path); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = lstatSync(parent);
  if (path.length > 100 || stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) ||
    (process.getuid && stat.uid !== process.getuid())) throw new TaskBridgeError('private_socket_directory_required', 503);
  await removeStale(path);
  const server = Bun.serve({ unix: path, maxRequestBodySize: 65536, fetch: taskBridgeHandler(service) });
  chmodSync(path, 0o600);
  const identity = lstatSync(path);
  return { async stop() {
    await server.stop(true); await service.close();
    if (existsSync(path) && lstatSync(path).ino === identity.ino) unlinkSync(path);
  } };
}
