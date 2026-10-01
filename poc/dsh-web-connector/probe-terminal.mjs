/** Summarize bounded, existing turn-end categories without returning identities or bodies. */
import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const runDir = join(homedir(), '.dsh', 'run')
const socketPath = join(runDir, 'sea-bridge.sock')
const tokenPath = join(runDir, 'sea-bridge.token')

/** Verify local-only connector paths before reading its ephemeral credential. */
async function assertPrivate(path) {
  const info = await stat(path)
  assert.equal(info.uid, process.getuid())
  assert.equal(info.mode & 0o077, 0)
}

/** Execute one fixed metadata-only read with a bounded response. */
function read(token, op, details = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let output = ''
    socket.setTimeout(3500, () => socket.destroy(new Error('metadata read timed out')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, op, ...details })}\n`))
    socket.on('data', chunk => {
      output += chunk
      if (output.length > 256_000) socket.destroy(new Error('metadata response too large'))
    })
    socket.on('end', () => {
      try {
        const result = JSON.parse(output)
        if (result.ok !== true) throw new Error('metadata read unavailable')
        resolve(result)
      } catch (error) { reject(error) }
    })
    socket.on('error', reject)
  })
}

await assertPrivate(runDir)
await assertPrivate(socketPath)
await assertPrivate(tokenPath)
const token = await readFile(tokenPath, 'utf8')
const sessions = await read(token, 'sessions.list')
const counts = new Map()
let scanned = 0
for (const session of sessions.items.slice(0, 30)) {
  const opening = await read(token, 'history.follow', { sessionId: session.sessionId })
  const page = await read(token, 'history.page', { sessionId: session.sessionId, throughSeq: opening.cursor })
  for (const event of page.events) {
    if (event.type !== 'turn/end') continue
    assert.ok([
      'stop', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked',
      'tool-calls', 'completed', 'unknown',
    ].includes(event.reasonKind))
    assert.ok(Number.isSafeInteger(event.turn))
    counts.set(event.reasonKind, (counts.get(event.reasonKind) ?? 0) + 1)
  }
  scanned++
  if ([...counts.values()].reduce((sum, count) => sum + count, 0) >= 6) break
}
process.stdout.write(`terminal metadata: scanned ${scanned} session(s), observed ${[...counts.values()].reduce((sum, count) => sum + count, 0)} turn/end event(s)\n`)
for (const kind of [...counts.keys()].sort()) process.stdout.write(`${kind}: ${counts.get(kind)}\n`)
