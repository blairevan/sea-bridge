/** Observe one organic live event, then read-only reconnect/recover; never write. */
import { strict as assert } from 'node:assert'
import { readFile, stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { recoverMetadata } from './recover-metadata.mjs'

const runDir = join(homedir(), '.dsh', 'run')
const socketPath = join(runDir, 'sea-bridge.sock')
const tokenPath = join(runDir, 'sea-bridge.token')

/** Refuse to use a token or socket outside this user's private runtime directory. */
async function assertPrivate(path) {
  const info = await stat(path)
  assert.equal(info.uid, process.getuid())
  assert.equal(info.mode & 0o077, 0)
}

/** Send one fixed read RPC and keep all metadata private to this process. */
function request(token, op, details = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let output = ''
    socket.setTimeout(op === 'history.followWindow' ? 17000 : 3500,
      () => socket.destroy(new Error(`${op} timed out`)))
    socket.on('connect', () => socket.write(`${JSON.stringify({ token, op, ...details })}\n`))
    socket.on('data', chunk => {
      output += chunk
      if (output.length > 2_000_000) socket.destroy(new Error('oversized response'))
    })
    socket.on('end', () => {
      try {
        const result = JSON.parse(output)
        if (result.ok !== true) throw new Error(`${op} unavailable`)
        resolve(result)
      } catch (error) { reject(error) }
    })
    socket.on('error', reject)
  })
}

/** Recover at most 32 historical seqs without emitting IDs, paths, or event content. */
async function recover(token, sessionId, fromSeq, throughSeq) {
  return await recoverMetadata(fromSeq, throughSeq,
    beforeSeq => request(token, 'history.page', {
      sessionId, throughSeq, ...beforeSeq === undefined ? {} : { beforeSeq },
    }))
}

await assertPrivate(runDir)
await assertPrivate(socketPath)
await assertPrivate(tokenPath)
const token = await readFile(tokenPath, 'utf8')
const sessions = await request(token, 'sessions.list')
assert.ok(Array.isArray(sessions.items))
const target = sessions.items.find(item => item.running) ?? sessions.items[0]
if (!target) {
  process.stdout.write('live follow: unverified; no visible session\n')
} else {
  process.stdout.write(`live follow: ${sessions.items.filter(item => item.running).length} running candidates\n`)
  const sessionId = target.sessionId
  const opening = await request(token, 'history.follow', { sessionId })
  assert.ok(Number.isSafeInteger(opening.cursor))
  if (opening.cursor >= 0) {
    const oldCursor = Math.max(-1, opening.cursor - 12)
    const historical = await recover(token, sessionId, oldCursor, opening.cursor)
    process.stdout.write(`historical gap simulation: continuous ${historical.count} seqs over ${historical.pages} page(s)\n`)
  } else {
    process.stdout.write('historical gap simulation: unverified; session has no events\n')
  }
  const live = await request(token, 'history.followWindow', { sessionId })
  if (live.observed === true) {
    assert.equal(live.event.seq, live.cursor + 1)
    const reconnect = await request(token, 'history.follow', { sessionId })
    assert.ok(reconnect.cursor >= live.event.seq)
    const recovered = await recover(token, sessionId, live.cursor, reconnect.cursor)
    process.stdout.write(`live event + reconnect: continuous ${recovered.count} seqs over ${recovered.pages} page(s)\n`)
  } else {
    process.stdout.write('post-snapshot live event: not observed within bounded window\n')
    process.stdout.write('live disconnect gap recovery: unverified\n')
  }
}
