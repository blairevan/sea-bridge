/** Probe only the temporary connector token and health endpoint, never Web auth. */
import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CONNECTOR_VERSION } from './read-operations.mjs'

const runDir = join(homedir(), '.dsh', 'run')
const socketPath = join(runDir, 'sea-bridge.sock')
const tokenPath = join(runDir, 'sea-bridge.token')

/** Refuse to use an insecure connector runtime path. */
async function assertPrivate(path) {
  const metadata = await stat(path)
  assert.equal(metadata.uid, process.getuid())
  assert.equal(metadata.mode & 0o077, 0)
}

/** Exchange one authenticated health request over the local Unix socket. */
function requestHealth(token) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('connector health timeout')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ op: 'health', token })}\n`))
    socket.on('data', chunk => {
      response += chunk
      if (response.length > 4096) socket.destroy(new Error('health response too large'))
    })
    socket.on('end', () => resolve(JSON.parse(response)))
    socket.on('error', reject)
  })
}

await assertPrivate(runDir)
await assertPrivate(socketPath)
await assertPrivate(tokenPath)
const token = await readFile(tokenPath, 'utf8')
assert.deepEqual(await requestHealth(token), {
  ok: true, status: 'mounted', protocol: 1, connectorVersion: CONNECTOR_VERSION,
})
process.stdout.write('connector health mounted; socket and token permissions private\n')
