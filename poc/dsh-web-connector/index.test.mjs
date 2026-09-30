import { strict as assert } from 'node:assert'
import { createConnection, createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply } from './index.mjs'
import { CONNECTOR_VERSION, dispatchRead } from './host-operations.mjs'

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

test('package version matches the runtime connector fingerprint', async () => {
  const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, CONNECTOR_VERSION)
})

test('Cordis mount uses private files and rejects unauthorized writes', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'sbp-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testHome
  let dispose
  try {
    apply({ effect: start => { dispose = start() } })
    const stop = await dispose
    const runDir = join(testHome, 'run')
    const socketPath = join(runDir, 'sea-bridge.sock')
    const tokenPath = join(runDir, 'sea-bridge.token')
    const token = await readFile(tokenPath, 'utf8')
    assert.equal((await stat(runDir)).mode & 0o077, 0)
    assert.equal((await stat(socketPath)).mode & 0o077, 0)
    assert.equal((await stat(tokenPath)).mode & 0o077, 0)
    assert.deepEqual(await request(socketPath, { op: 'health', token: 'invalid' }), { ok: false, error: 'unauthorized' })
    assert.deepEqual(await request(socketPath, { op: 'health', token }), {
      ok: true, status: 'mounted', protocol: 1, connectorVersion: CONNECTOR_VERSION,
    })
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

test('authenticated socket accepts the fixed write surface and an 8K CJK prompt', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'sbp-write-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testHome
  const calls = []
  let dispose
  try {
    apply({
      workspaceRegistry: { list: () => [{ id: 'workspace-1', title: 'Project', sessionIds: [] }] },
      sessionController: {
        create: async request => {
          calls.push(['create', request])
          return { sessionId: request.sessionId }
        },
        selectModel: async request => {
          calls.push(['model', request])
          return { selected: { provider: request.provider, model: request.model } }
        },
        prompt: async request => {
          calls.push(['prompt', request])
          return { accepted: true }
        },
      },
      effect: start => { dispose = start() },
    })
    const stop = await dispose
    const runDir = join(testHome, 'run')
    const socketPath = join(runDir, 'sea-bridge.sock')
    const token = await readFile(join(runDir, 'sea-bridge.token'), 'utf8')
    const longText = '测试'.repeat(4096)
    assert.ok(Buffer.byteLength(longText, 'utf8') > 16 * 1024)

    assert.deepEqual(await request(socketPath, {
      op: 'session.create', token, workspaceId: 'workspace-1', sessionId: 'session-sea-bridge-test',
    }), { ok: true, status: 'accepted', sessionId: 'session-sea-bridge-test' })
    assert.deepEqual(await request(socketPath, {
      op: 'session.selectModel', token, sessionId: 'session-sea-bridge-test', provider: 'p', model: 'm',
    }), { ok: true, status: 'accepted', selected: { provider: 'p', model: 'm' } })
    assert.deepEqual(await request(socketPath, {
      op: 'prompt.submit', token, sessionId: 'session-sea-bridge-test', requestId: 'req-long', text: longText,
    }), { ok: true, status: 'accepted' })
    assert.equal(calls.length, 3)
    assert.equal(calls[2][1].content[0].text, longText)

    await stop()
    dispose = undefined
  } finally {
    if (dispose) await (await dispose)().catch(() => {})
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(testHome, { recursive: true, force: true })
  }
})

test('permanent mount recovers an owner-private stale token left by an unclean exit', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'sbp-stale-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testHome
  let dispose
  try {
    const runDir = join(testHome, 'run')
    const tokenPath = join(runDir, 'sea-bridge.token')
    await mkdir(runDir, { mode: 0o700 })
    await writeFile(tokenPath, 'stale-token', { mode: 0o600 })
    apply({ effect: start => { dispose = start() } })
    const stop = await dispose
    const token = await readFile(tokenPath, 'utf8')
    assert.notEqual(token, 'stale-token')
    assert.equal(token.length, 64)
    await stop()
    dispose = undefined
  } finally {
    if (dispose) await (await dispose)().catch(() => {})
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(testHome, { recursive: true, force: true })
  }
})

test('permanent mount never replaces an active owner-private connector socket', async () => {
  const testHome = await mkdtemp(join(tmpdir(), 'sbp-active-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = testHome
  let server
  try {
    const runDir = join(testHome, 'run')
    const socketPath = join(runDir, 'sea-bridge.sock')
    const tokenPath = join(runDir, 'sea-bridge.token')
    await mkdir(runDir, { mode: 0o700 })
    await writeFile(tokenPath, 'a'.repeat(64), { mode: 0o600 })
    server = createServer(socket => socket.destroy())
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    await chmod(socketPath, 0o600)
    let start
    apply({ effect: effect => { start = effect() } })
    await assert.rejects(start, /already active/)
    assert.equal((await stat(tokenPath)).mode & 0o077, 0)
    assert.equal((await stat(socketPath)).mode & 0o077, 0)
  } finally {
    if (server?.listening) await new Promise(resolve => server.close(resolve))
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(testHome, { recursive: true, force: true })
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

test('bounded follow window projects only the next contiguous live event', async () => {
  let released = false
  const ctx = {
    sessionController: {
      follow: async function* () {
        try {
          yield { type: 'snapshot', cursor: 4, records: [], hasMore: true }
          yield { type: 'event', event: {
            type: 'assistant/message', seq: 5, time: 44, data: { text: 'private live text' },
          } }
        } finally {
          released = true
        }
      },
    },
  }
  const result = await dispatchRead({ op: 'history.followWindow', token: 'test', sessionId: 'session-1' }, ctx)
  assert.deepEqual(result, { ok: true, observed: true, cursor: 4,
    event: { type: 'assistant/message', seq: 5, time: 44 } })
  assert.equal(released, true)
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('turn end projects only a fixed reason category without error or message contents', async () => {
  const ctx = { sessionController: { page: async () => ({ records: [
    { type: 'event', event: { type: 'turn/end', seq: 3, time: 55,
      data: { reason: { kind: 'error', failure: { message: 'private failure' } }, text: 'private text' } } },
    { type: 'event', event: { type: 'turn/end', seq: 4, time: 56,
      data: { reason: { kind: 'private-proprietary', secret: 'private' } } } },
  ], hasMore: false }) } }
  const result = await dispatchRead({ op: 'history.page', sessionId: 'session-1', throughSeq: 4 }, ctx)
  assert.deepEqual(result.events, [
    { type: 'turn/end', seq: 3, time: 55, reasonKind: 'error' },
    { type: 'turn/end', seq: 4, time: 56, reasonKind: 'unknown' },
  ])
  assert.equal(JSON.stringify(result).includes('private'), false)
})

test('allowlisted writes use exact Session Controller contracts and classify outcomes', async () => {
  const calls = []
  const ctx = {
    workspaceRegistry: { list: () => [{ id: 'workspace-1', title: 'Project', sessionIds: [] }] },
    sessionController: {
      create: async request => {
        calls.push(['create', request])
        return { sessionId: request.sessionId, agentPreset: 'default' }
      },
      selectModel: async request => {
        calls.push(['model', request])
        return { selected: { provider: request.provider, model: request.model } }
      },
      prompt: async (request, signal) => {
        calls.push(['prompt', request, signal instanceof AbortSignal])
        return { accepted: true }
      },
    },
  }
  assert.deepEqual(await dispatchRead({
    op: 'session.create', workspaceId: 'workspace-1', sessionId: 'sea-bridge-1',
  }, ctx), {
    ok: true, status: 'accepted', sessionId: 'sea-bridge-1', agentPreset: 'default',
  })
  assert.deepEqual(await dispatchRead({
    op: 'session.selectModel', sessionId: 'sea-bridge-1', provider: 'p', model: 'm',
  }, ctx), {
    ok: true, status: 'accepted', selected: { provider: 'p', model: 'm' },
  })
  assert.deepEqual(await dispatchRead({
    op: 'prompt.submit', sessionId: 'sea-bridge-1', requestId: 'req-1', text: 'hello',
  }, ctx), { ok: true, status: 'accepted' })
  assert.deepEqual(calls[0], ['create', { workspaceId: 'workspace-1', sessionId: 'sea-bridge-1' }])
  assert.deepEqual(calls[1], ['model', { sessionId: 'sea-bridge-1', provider: 'p', model: 'm' }])
  assert.deepEqual(calls[2][1], {
    requestId: 'req-1', sessionId: 'sea-bridge-1', mode: 'queue',
    content: [{ type: 'text', text: 'hello' }],
  })
  assert.equal(calls[2][2], true)

  const busy = { sessionController: {
    prompt: async () => { throw Object.assign(new Error('busy'), { code: 'session/agent-busy' }) },
  } }
  assert.deepEqual(await dispatchRead({
    op: 'prompt.submit', sessionId: 'session-1', requestId: 'req-2', text: 'hello',
  }, busy), { ok: true, status: 'busy_or_writer_held', errorCode: 'session/agent-busy' })

  const unknown = { sessionController: {
    prompt: async () => { throw new Error('transportish unknown') },
  } }
  assert.deepEqual(await dispatchRead({
    op: 'prompt.submit', sessionId: 'session-1', requestId: 'req-3', text: 'hello',
  }, unknown), { ok: true, status: 'delivery_unknown', errorCode: 'host_write_unknown' })
  assert.deepEqual(await dispatchRead({
    op: 'session.create', workspaceId: 'missing', sessionId: 'sea-bridge-2',
  }, ctx), { ok: true, status: 'rejected', errorCode: 'project_missing' })
})
