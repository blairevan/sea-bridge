import { strict as assert } from 'node:assert'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rmdir, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from './index.mjs'
import { dispatchRead } from './read-operations.mjs'

/** Send one bounded request to a temporary PoC socket and parse its reply. */
function request(socketPath, payload) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setTimeout(1000, () => socket.destroy(new Error('test socket timeout')))
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`))
    socket.on('data', chunk => { response += chunk })
    socket.on('end', () => resolve(JSON.parse(response)))
    socket.on('error', reject)
  })
}

test('Cordis mount uses private files and rejects unauthorized writes', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'sbp-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testHome
  let dispose
  try {
    apply({ effect: start => { dispose = start() } })
    const stop = await dispose
    const runDir = join(testHome, 'run')
    const socketPath = join(runDir, 'sea-bridge-poc.sock')
    const tokenPath = join(runDir, 'sea-bridge-poc.token')
    const token = await readFile(tokenPath, 'utf8')
    assert.equal((await stat(runDir)).mode & 0o077, 0)
    assert.equal((await stat(socketPath)).mode & 0o077, 0)
    assert.equal((await stat(tokenPath)).mode & 0o077, 0)
    assert.deepEqual(await request(socketPath, { op: 'health', token: 'invalid' }), { ok: false, error: 'unauthorized' })
    assert.deepEqual(await request(socketPath, { op: 'health', token }), { ok: true, status: 'mounted', protocol: 1 })
    assert.deepEqual(await request(socketPath, { op: 'session.prompt', token }), { ok: false, error: 'unsupported' })
    await stop()
    dispose = undefined
    await assert.rejects(stat(socketPath), { code: 'ENOENT' })
    await assert.rejects(stat(tokenPath), { code: 'ENOENT' })
    await rmdir(runDir)
  } finally {
    if (dispose) await (await dispose)()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rmdir(testHome)
  }
})

test('allowlisted reads project metadata without paths, projections, or event content', async () => {
  const event = { type: 'event', event: {
    type: 'assistant/message', seq: 2, time: 42, data: { text: 'private session text' },
  } }
  let followed = false
  const ctx = {
    workspaceRegistry: { list: () => [{
      id: 'workspace-1', title: 'Project', path: '/private/path', sessionIds: ['session-1'],
    }] },
    sessionController: {
      list: async () => ({ items: [{
        sessionId: 'session-1', updatedAt: 42, running: false, blank: false,
        cwd: '/private/path', projections: { secret: 'private' },
      }] }),
      page: async () => ({ records: [event], hasMore: false }),
      follow: async function* () {
        followed = true
        yield { type: 'snapshot', cursor: 2, hasMore: false, records: [event],
          header: { cwd: '/private/path' }, projections: { secret: 'private' } }
      },
      modelCatalog: async () => ({ default: { provider: 'p', model: 'm', secret: 'private' },
        groups: [{ id: 'p', name: 'Provider', models: [{ id: 'm', name: 'Model', secret: 'private' }] }],
        failures: [{ message: 'private error' }],
      }),
    },
  }
  const outputs = [
    await dispatchRead({ op: 'projects.list', token: 'test' }, ctx),
    await dispatchRead({ op: 'sessions.list', token: 'test' }, ctx),
    await dispatchRead({ op: 'history.follow', token: 'test', sessionId: 'session-1' }, ctx),
    await dispatchRead({ op: 'history.page', token: 'test', sessionId: 'session-1', throughSeq: 2 }, ctx),
    await dispatchRead({ op: 'models.catalog', token: 'test' }, ctx),
  ]
  assert.equal(followed, true)
  assert.equal(outputs[0].items[0].sessionCount, 1)
  assert.equal(outputs[1].items[0].sessionId, 'session-1')
  assert.equal(outputs[2].cursor, 2)
  assert.equal(outputs[3].events[0].seq, 2)
  assert.equal(outputs[4].groups[0].models[0].id, 'm')
  assert.equal(outputs.every(output => output.ok), true)
  assert.equal(JSON.stringify(outputs).includes('private'), false)
  assert.deepEqual(await dispatchRead({ op: 'session.prompt', token: 'test' }, ctx),
    { ok: false, error: 'unsupported' })
  await assert.rejects(dispatchRead({ op: 'history.page', token: 'test',
    sessionId: '../bad', throughSeq: 2 }, ctx), /invalid_request/)
})
