/** Fixed Host surface: metadata reads plus one bounded terminal-text projection and allowlisted writes. */

export const CONNECTOR_VERSION = '0.4.0'
const READ_TIMEOUT_MS = 2500
const LIVE_WINDOW_MS = 12000
const WRITE_TIMEOUT_MS = 12000
const TURN_SUMMARY_MAX_PAGES = 8
const TURN_SUMMARY_MAX_TEXT_CHARS = 1_000_000

/** Require one opaque Session id without accepting paths or arbitrary objects. */
function sessionIdOf(request) {
  if (typeof request.sessionId !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(request.sessionId)) {
    throw new Error('invalid_request')
  }
  return request.sessionId
}

/** Bound a Host read and abort cancellable reads on completion or timeout. */
async function withDeadline(read, durationMs = READ_TIMEOUT_MS) {
  const controller = new AbortController()
  let timer
  try {
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('read_timeout'))
      }, durationMs)
    })
    return await Promise.race([Promise.resolve().then(() => read(controller.signal)), deadline])
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

/** Strip cwd and arbitrary projections while allowing the verified durable title projection. */
function sessionSummary(row) {
  if (typeof row?.sessionId !== 'string' || typeof row.updatedAt !== 'number') {
    throw new Error('invalid_host_response')
  }
  const title = row?.projections?.values?.title
  return {
    sessionId: row.sessionId,
    updatedAt: row.updatedAt,
    running: row.running === true,
    blank: row.blank === true,
    ...(typeof title === 'string' && title.trim().length > 0 ? { title: title.slice(0, 2048) } : {}),
  }
}

/** Expose only event identity/order plus the verified turn number for terminal records. */
function eventMetadata(record) {
  const event = record?.event
  if (record?.type !== 'event' || typeof event?.type !== 'string' ||
    !Number.isSafeInteger(event.seq) || typeof event.time !== 'number') {
    throw new Error('invalid_host_response')
  }
  const metadata = { type: event.type, seq: event.seq, time: event.time }
  if (event.type === 'turn/end') {
    if (!Number.isSafeInteger(event.data?.turn) || event.data.turn < 0) {
      throw new Error('invalid_host_response')
    }
    metadata.turn = event.data.turn
    const kind = event.data?.reason?.kind
    metadata.reasonKind = [
      'completed', 'error', 'aborted', 'blocked', 'max-tokens', 'interrupted', 'forked',
      'stop', 'tool-calls',
    ].includes(kind) ? kind : 'unknown'
  }
  return metadata
}

/** Extract only user-visible committed assistant text; reasoning/tool/file/image blocks stay private. */
function assistantTextOf(event) {
  const content = event?.data?.message?.content
  if (!Array.isArray(content)) throw new Error('invalid_host_response')
  let text = ''
  for (const block of content) {
    if (block?.type !== 'text') continue
    if (typeof block.text !== 'string') throw new Error('invalid_host_response')
    text += block.text
    if (text.length > TURN_SUMMARY_MAX_TEXT_CHARS) throw new Error('assistant_text_too_large')
  }
  return text
}

/** Find the latest committed assistant message for one completed turn without exposing arbitrary event data. */
async function readTurnSummary(ctx, sessionId, turn, throughSeq) {
  let beforeSeq
  for (let pageIndex = 0; pageIndex < TURN_SUMMARY_MAX_PAGES; pageIndex++) {
    const pageRequest = {
      address: { kind: 'session', sessionId },
      throughSeq,
      maxMessages: 1,
    }
    if (beforeSeq !== undefined) pageRequest.beforeSeq = beforeSeq
    const result = await withDeadline(signal => ctx.sessionController.page(pageRequest, signal))
    if (!Array.isArray(result?.records)) throw new Error('invalid_host_response')
    if (result.records.length === 0) return { turn, assistantSeq: null, assistantText: null }
    for (let index = result.records.length - 1; index >= 0; index--) {
      const record = result.records[index]
      const event = record?.event
      if (record?.type !== 'event' || typeof event?.type !== 'string' || !Number.isSafeInteger(event.seq)) {
        throw new Error('invalid_host_response')
      }
      if (event.type === 'assistant/message' && event.data?.turn === turn) {
        const assistantText = assistantTextOf(event)
        if (assistantText.length > 0) {
          return { turn, assistantSeq: event.seq, assistantText }
        }
      }
      if (event.type === 'turn/start' && event.data?.turn === turn) {
        return { turn, assistantSeq: null, assistantText: null }
      }
      if (Number.isSafeInteger(event.data?.turn) && event.data.turn < turn) {
        return { turn, assistantSeq: null, assistantText: null }
      }
    }
    if (result.hasMore !== true) return { turn, assistantSeq: null, assistantText: null }
    const firstSeq = result.records[0]?.event?.seq
    if (!Number.isSafeInteger(firstSeq) || (beforeSeq !== undefined && firstSeq >= beforeSeq)) {
      throw new Error('invalid_host_response')
    }
    beforeSeq = firstSeq
  }
  throw new Error('turn_summary_page_limit')
}

/** Require no caller-controlled arguments for fixed collection operations. */
function noArguments(request) {
  if (Object.keys(request).some(key => key !== 'token' && key !== 'op')) {
    throw new Error('invalid_request')
  }
}

function boundedString(value, name, max = 8192) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new Error('invalid_request')
  }
  return value
}

function remoteCode(error) {
  if (typeof error?.code === 'string') return error.code
  if (typeof error?.name === 'string' && error.name.includes('/')) return error.name
  return undefined
}

function classifyWriteError(error) {
  const code = remoteCode(error)
  if (code === 'session/agent-busy' || code === 'session/writer-held') {
    return { ok: true, status: 'busy_or_writer_held', errorCode: code }
  }
  if (code === 'workspace/not-found') {
    return { ok: true, status: 'rejected', errorCode: 'project_missing' }
  }
  if (code === 'session/model-unavailable' || code === 'session/provider-models-unavailable' ||
    code === 'session/provider-credentials-unavailable') {
    return { ok: true, status: 'rejected', errorCode: 'model_unavailable' }
  }
  if (code === 'session/conflict' || code === 'agent-preset/conflict' ||
    code === 'session/invalid-time-zone' || code === 'session/attachment-invalid' ||
    code === 'gateway/bad-request') {
    return { ok: true, status: 'rejected', errorCode: 'validation_failed' }
  }
  if (typeof code === 'string' && (code.endsWith('/not-found') || code.includes('not-found'))) {
    return { ok: true, status: 'rejected', errorCode: 'session_missing' }
  }
  return { ok: true, status: 'delivery_unknown', errorCode: 'host_write_unknown' }
}

/** Call one explicitly listed Host operation; no dynamic method dispatch is possible. */
export async function dispatchRead(request, ctx) {
  if (request.op === 'health') {
    noArguments(request)
    return { ok: true, status: 'mounted', protocol: 1, connectorVersion: CONNECTOR_VERSION }
  }
  if (request.op === 'projects.list') {
    noArguments(request)
    const workspaces = ctx.workspaceRegistry.list()
    if (!Array.isArray(workspaces)) throw new Error('invalid_host_response')
    return { ok: true, totalCount: workspaces.length, items: workspaces.slice(0, 200).map(workspace => ({
      id: String(workspace.id),
      title: String(workspace.title),
      sessionCount: workspace.sessionIds.length,
    })) }
  }
  if (request.op === 'sessions.list') {
    noArguments(request)
    const result = await withDeadline(signal => ctx.sessionController.list({}, signal))
    if (!Array.isArray(result?.items)) throw new Error('invalid_host_response')
    return { ok: true, totalCount: result.items.length,
      items: result.items.slice(0, 200).map(sessionSummary) }
  }
  if (request.op === 'history.follow') {
    if (Object.keys(request).some(key => !['token', 'op', 'sessionId'].includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    const frame = await withDeadline(async signal => {
      const iterator = ctx.sessionController.follow({
        address: { kind: 'session', sessionId }, maxMessages: 1,
      }, signal)[Symbol.asyncIterator]()
      try {
        const next = await iterator.next()
        if (next.done) throw new Error('empty_follow')
        return next.value
      } finally {
        if (typeof iterator.return === 'function') {
          Promise.resolve(iterator.return()).catch(() => {})
        }
      }
    })
    if (frame?.type !== 'snapshot' || !Number.isSafeInteger(frame.cursor) ||
      !Array.isArray(frame.records)) throw new Error('invalid_host_response')
    return { ok: true, cursor: frame.cursor, hasMore: frame.hasMore === true,
      truncated: frame.records.length > 100,
      events: frame.records.slice(0, 100).map(eventMetadata) }
  }
  if (request.op === 'history.followWindow') {
    if (Object.keys(request).some(key => !['token', 'op', 'sessionId'].includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    let openingCursor
    try {
      return await withDeadline(async signal => {
        const iterator = ctx.sessionController.follow({
          address: { kind: 'session', sessionId }, maxMessages: 1,
        }, signal)[Symbol.asyncIterator]()
        try {
          const first = await iterator.next()
          if (first.done || first.value?.type !== 'snapshot' ||
            !Number.isSafeInteger(first.value.cursor)) throw new Error('invalid_host_response')
          openingCursor = first.value.cursor
          const next = await iterator.next()
          if (next.done && signal.aborted) return { ok: true, observed: false, cursor: openingCursor }
          if (next.done || next.value?.type !== 'event') throw new Error('invalid_host_response')
          const event = eventMetadata(next.value)
          if (event.seq !== openingCursor + 1) throw new Error('noncontiguous_live_event')
          return { ok: true, observed: true, cursor: openingCursor, event }
        } finally {
          if (typeof iterator.return === 'function') {
            Promise.resolve(iterator.return()).catch(() => {})
          }
        }
      }, LIVE_WINDOW_MS)
    } catch (error) {
      if (error?.message === 'read_timeout' && Number.isSafeInteger(openingCursor)) {
        return { ok: true, observed: false, cursor: openingCursor }
      }
      throw error
    }
  }
  if (request.op === 'turn.summary') {
    const allowed = ['token', 'op', 'sessionId', 'turn', 'throughSeq']
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    if (!Number.isSafeInteger(request.turn) || request.turn < 0 ||
      !Number.isSafeInteger(request.throughSeq) || request.throughSeq < 0) {
      throw new Error('invalid_request')
    }
    const summary = await readTurnSummary(ctx, sessionId, request.turn, request.throughSeq)
    return { ok: true, ...summary }
  }
  if (request.op === 'history.page') {
    const allowed = ['token', 'op', 'sessionId', 'throughSeq', 'beforeSeq']
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    if (!Number.isSafeInteger(request.throughSeq) || request.throughSeq < -1) throw new Error('invalid_request')
    if (request.beforeSeq !== undefined &&
      (!Number.isSafeInteger(request.beforeSeq) || request.beforeSeq < 0)) throw new Error('invalid_request')
    const pageRequest = {
      address: { kind: 'session', sessionId }, throughSeq: request.throughSeq,
      maxMessages: 1,
    }
    if (request.beforeSeq !== undefined) pageRequest.beforeSeq = request.beforeSeq
    const result = await withDeadline(signal => ctx.sessionController.page(pageRequest, signal))
    if (!Array.isArray(result?.records)) throw new Error('invalid_host_response')
    return { ok: true, hasMore: result.hasMore === true, truncated: result.records.length > 100,
      events: result.records.slice(0, 100).map(eventMetadata) }
  }
  if (request.op === 'prompt.submit') {
    const allowed = ['token', 'op', 'sessionId', 'requestId', 'text']
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    const requestId = boundedString(request.requestId, 'requestId', 160)
    const text = boundedString(request.text, 'text', 8192)
    if (text.trim().length === 0) throw new Error('invalid_request')
    try {
      const result = await withDeadline(signal => ctx.sessionController.prompt({
        requestId,
        sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      }, signal), WRITE_TIMEOUT_MS)
      if (result?.accepted !== true) return { ok: true, status: 'delivery_unknown', errorCode: 'invalid_prompt_receipt' }
      return { ok: true, status: 'accepted' }
    } catch (error) {
      return classifyWriteError(error)
    }
  }
  if (request.op === 'session.create') {
    const allowed = ['token', 'op', 'workspaceId', 'sessionId']
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('invalid_request')
    const workspaceId = boundedString(request.workspaceId, 'workspaceId', 200)
    const sessionId = sessionIdOf(request)
    const workspaces = ctx.workspaceRegistry.list()
    if (!Array.isArray(workspaces) || !workspaces.some(workspace => String(workspace.id) === workspaceId)) {
      return { ok: true, status: 'rejected', errorCode: 'project_missing' }
    }
    try {
      const value = await withDeadline(() => ctx.sessionController.create({ workspaceId, sessionId }), WRITE_TIMEOUT_MS)
      if (typeof value?.sessionId !== 'string' || value.sessionId !== sessionId) {
        return { ok: true, status: 'delivery_unknown', errorCode: 'invalid_create_receipt' }
      }
      return {
        ok: true,
        status: 'accepted',
        sessionId: value.sessionId,
        ...(typeof value.agentPreset === 'string' ? { agentPreset: value.agentPreset } : {}),
      }
    } catch (error) {
      return classifyWriteError(error)
    }
  }
  if (request.op === 'session.selectModel') {
    const allowed = ['token', 'op', 'sessionId', 'provider', 'model', 'reasoningEffort']
    if (Object.keys(request).some(key => !allowed.includes(key))) throw new Error('invalid_request')
    const sessionId = sessionIdOf(request)
    const provider = boundedString(request.provider, 'provider', 200)
    const model = boundedString(request.model, 'model', 200)
    const selection = { sessionId, provider, model }
    if (request.reasoningEffort !== undefined) {
      selection.reasoningEffort = boundedString(request.reasoningEffort, 'reasoningEffort', 100)
    }
    try {
      const value = await withDeadline(() => ctx.sessionController.selectModel(selection), WRITE_TIMEOUT_MS)
      const selected = value?.selected
      if (typeof selected?.provider !== 'string' || typeof selected?.model !== 'string') {
        return { ok: true, status: 'delivery_unknown', errorCode: 'invalid_model_receipt' }
      }
      return {
        ok: true,
        status: 'accepted',
        selected: {
          provider: selected.provider,
          model: selected.model,
          ...(typeof selected.reasoningEffort === 'string' ? { reasoningEffort: selected.reasoningEffort } : {}),
        },
      }
    } catch (error) {
      return classifyWriteError(error)
    }
  }
  if (request.op === 'models.catalog') {
    noArguments(request)
    const catalog = await withDeadline(() => ctx.sessionController.modelCatalog())
    if (!Array.isArray(catalog?.groups)) throw new Error('invalid_host_response')
    const selection = catalog.default
    if (typeof selection?.provider !== 'string' || typeof selection.model !== 'string') {
      throw new Error('invalid_host_response')
    }
    return { ok: true, default: {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    }, groupCount: catalog.groups.length, groups: catalog.groups.slice(0, 50).map(group => ({
      id: group.id, name: group.name, modelCount: group.models.length,
      models: group.models.slice(0, 200).map(model => ({ id: model.id, name: model.name })),
    })), failureCount: catalog.failures?.length ?? 0 }
  }
  return { ok: false, error: 'unsupported' }
}
