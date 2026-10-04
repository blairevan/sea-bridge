/** Sequential fixed-surface read probe; terminal text is validated in memory and never printed. */
import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const runDir = join(homedir(), '.dsh', 'run')
const socketPath = join(runDir, 'sea-bridge.sock')
const tokenPath = join(runDir, 'sea-bridge.token')

/** Require private ownership and permissions before reading the connector token. */
async function assertPrivate(path) {
  const info = await stat(path)
  assert.equal(info.uid, process.getuid())
  assert.equal(info.mode & 0o077, 0)
}

/** Send one allowlisted request and keep all response content in process memory. */
function readOperation(token, op, details = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setTimeout(op === 'turn.summary' ? 25000 : 3500,
      () => socket.destroy(new Error('read probe timeout')))
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, op, ...details })}\n`))
    socket.on('data', chunk => {
      response += chunk
      if (response.length > 8_000_000) socket.destroy(new Error('read response too large'))
    })
    socket.on('end', () => {
      try { resolve(JSON.parse(response)) } catch (error) { reject(error) }
    })
    socket.on('error', reject)
  })
}

/** Fail with the operation name only, never with Host text or identifiers. */
async function requireRead(token, op, details) {
  const result = await readOperation(token, op, details)
  if (result?.ok !== true) throw new Error(`${op} not available`)
  return result
}

await assertPrivate(runDir)
await assertPrivate(socketPath)
await assertPrivate(tokenPath)
const token = await readFile(tokenPath, 'utf8')
await requireRead(token, 'health')
process.stdout.write('health: passed\n')

const projects = await requireRead(token, 'projects.list')
assert.ok(Array.isArray(projects.items))
process.stdout.write(`projects: passed (${projects.totalCount} registered)\n`)

const sessions = await requireRead(token, 'sessions.list')
assert.ok(Array.isArray(sessions.items))
process.stdout.write(`sessions: passed (${sessions.totalCount} visible)\n`)

if (sessions.items.length > 0) {
  const sessionId = sessions.items[0].sessionId
  const follow = await requireRead(token, 'history.follow', { sessionId })
  assert.ok(Number.isSafeInteger(follow.cursor))
  process.stdout.write('follow: opening snapshot passed\n')
  const reconnected = await requireRead(token, 'history.follow', { sessionId })
  assert.ok(Number.isSafeInteger(reconnected.cursor))
  assert.ok(reconnected.cursor >= follow.cursor)
  process.stdout.write('follow: bounded reconnect passed\n')
  const page = await requireRead(token, 'history.page', { sessionId, throughSeq: follow.cursor })
  assert.ok(Array.isArray(page.events))
  process.stdout.write('page: passed\n')
  const terminal = page.events.findLast(event =>
    event.type === 'turn/end' && Number.isSafeInteger(event.turn))
  if (terminal) {
    const summary = await requireRead(token, 'turn.summary', {
      sessionId, turn: terminal.turn, throughSeq: terminal.seq,
    })
    assert.equal(summary.turn, terminal.turn)
    assert.ok(summary.assistantSeq === null || Number.isSafeInteger(summary.assistantSeq))
    assert.ok(summary.assistantText === null || typeof summary.assistantText === 'string')
    process.stdout.write(`turn summary: passed (${summary.assistantText === null ? 'no visible text' : 'visible text projected'})\n`)
  } else {
    process.stdout.write('turn summary: unverified (no terminal event in bounded page)\n')
  }
} else {
  process.stdout.write('follow/page: unverified (no visible sessions)\n')
}

const catalog = await requireRead(token, 'models.catalog')
assert.ok(Array.isArray(catalog.groups))
assert.equal(catalog.groupCount, catalog.groups.length)
for (const group of catalog.groups) {
  assert.equal(group.modelCount, group.models.length)
}
process.stdout.write(`models: passed (${catalog.groups.length} provider groups; ${catalog.failureCount} isolated failures)\n`)
