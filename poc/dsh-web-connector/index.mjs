/** Narrow Sea-Bridge Cordis plugin for the active dsh Web Host. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createConnection, createServer } from 'node:net'
import { chmod, lstat, mkdir, open, stat, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { dispatchRead } from './host-operations.mjs'

export const name = 'sea-bridge-dsh-web-connector'
export const inject = ['sessionController', 'workspaceRegistry']

const MAX_REQUEST_BYTES = 64 * 1024
const REQUEST_TIMEOUT_MS = 3000

/** Resolve a private runtime directory without touching browser or dsh credentials. */
function runDirectory() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'run')
}

/** Ensure the connector only uses a private, owner-controlled runtime directory. */
async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid()) {
    throw new Error('connector runtime directory is not private')
  }
}

/** Inspect only connector-owned private runtime paths; wrong types or permissions fail closed. */
async function privateRuntimePath(path, expected) {
  try {
    const info = await lstat(path)
    if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0 ||
      (expected === 'socket' ? !info.isSocket() : !info.isFile())) {
      throw new Error('connector runtime path is not private or has the wrong type')
    }
    return info
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/** Determine whether an existing private Unix socket is still serving another connector. */
async function socketIsLive(path) {
  return await new Promise((resolve, reject) => {
    const socket = createConnection(path)
    let settled = false
    const finish = (callback) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeAllListeners()
      socket.destroy()
      callback()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('connector runtime socket probe timed out'))), 500)
    socket.once('connect', () => finish(() => resolve(true)))
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') {
        finish(() => resolve(false))
      } else {
        finish(() => reject(error))
      }
    })
  })
}

/** Recover only stale files created by this connector; never replace a live or unsafe path. */
async function recoverStaleRuntime(socketPath, tokenPath) {
  const socketInfo = await privateRuntimePath(socketPath, 'socket')
  const tokenInfo = await privateRuntimePath(tokenPath, 'file')
  if (socketInfo && await socketIsLive(socketPath)) {
    throw new Error('connector runtime socket is already active')
  }
  if (socketInfo) await unlink(socketPath)
  if (tokenInfo) await unlink(tokenPath)
}

/** Send one small JSON response and end the client connection. */
function respond(socket, result) {
  socket.end(`${JSON.stringify(result)}\n`)
}

/** Authenticate one allowlisted metadata request without echoing caller input. */
function handleClient(socket, token, ctx) {
  let input = ''
  socket.setTimeout(REQUEST_TIMEOUT_MS, () => socket.destroy())
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    input += chunk
    if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) {
      socket.destroy()
      return
    }
    const lineEnd = input.indexOf('\n')
    if (lineEnd < 0) return
    socket.removeAllListeners('data')
    try {
      const request = JSON.parse(input.slice(0, lineEnd))
      const supplied = typeof request?.token === 'string' ? Buffer.from(request.token, 'utf8') : Buffer.alloc(0)
      const authenticated = supplied.length === token.length && timingSafeEqual(supplied, token)
      if (!authenticated) {
        respond(socket, { ok: false, error: 'unauthorized' })
      } else {
        if (request.op === 'history.followWindow') socket.setTimeout(18000, () => socket.destroy())
        if (request.op === 'turn.summary') socket.setTimeout(25000, () => socket.destroy())
        void dispatchRead(request, ctx).then(result => respond(socket, result)).catch(error => {
          respond(socket, {
            ok: false,
            error: error?.message === 'invalid_request' ? 'invalid_request' : 'operation_unavailable',
          })
        })
      }
    } catch {
      respond(socket, { ok: false, error: 'invalid_request' })
    }
  })
}

/** Bind a private allowlisted socket and release only resources created by this mount. */
async function mountHealthSocket(ctx) {
  const directory = runDirectory()
  const socketPath = join(directory, 'sea-bridge.sock')
  const tokenPath = join(directory, 'sea-bridge.token')
  if (Buffer.byteLength(socketPath) > 100) throw new Error('connector Unix socket path is too long')
  await ensurePrivateDirectory(directory)
  await recoverStaleRuntime(socketPath, tokenPath)

  const token = randomBytes(32).toString('hex')
  const tokenFile = await open(tokenPath, 'wx', 0o600)
  let server
  let socketBound = false
  try {
    await tokenFile.writeFile(token, 'utf8')
    await tokenFile.close()
    server = createServer(socket => handleClient(socket, Buffer.from(token), ctx))
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        socketBound = true
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    const socketInfo = await stat(socketPath)
    const fileInfo = await stat(tokenPath)
    if ((socketInfo.mode & 0o077) !== 0 || (fileInfo.mode & 0o077) !== 0) {
      throw new Error('connector runtime permissions are not private')
    }
  } catch (error) {
    await tokenFile.close().catch(() => {})
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (socketBound) await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e })
    await unlink(tokenPath).catch(e => { if (e.code !== 'ENOENT') throw e })
    throw error
  }

  return async () => {
    server.closeAllConnections?.()
    await new Promise(resolve => server.close(resolve))
    await unlink(socketPath).catch(e => { if (e.code !== 'ENOENT') throw e })
    await unlink(tokenPath).catch(e => { if (e.code !== 'ENOENT') throw e })
  }
}

/** Mount the read endpoint only after Cordis activates this plugin. */
export function apply(ctx) {
  ctx.effect(() => mountHealthSocket(ctx), 'sea-bridge-dsh-web-connector: read socket')
}
