/** Fixed, metadata-only Host read surface for the temporary connector. */

export const CONNECTOR_VERSION = '0.2.0'
const READ_TIMEOUT_MS = 2500
const LIVE_WINDOW_MS = 12000

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

/** Strip cwd, projections, text, and other unverified Host fields. */
function sessionSummary(row) {
  if (typeof row?.sessionId !== 'string' || typeof row.updatedAt !== 'number') {
    throw new Error('invalid_host_response')
  }
  return {
    sessionId: row.sessionId,
    updatedAt: row.updatedAt,
    running: row.running === true,
    blank: row.blank === true,
  }
}

/** Expose only event identity and ordering, never event data. */
function eventMetadata(record) {
  const event = record?.event
  if (record?.type !== 'event' || typeof event?.type !== 'string' ||
    !Number.isSafeInteger(event.seq) || typeof event.time !== 'number') {
    throw new Error('invalid_host_response')
  }
  const metadata = { type: event.type, seq: event.seq, time: event.time }
  if (event.type === 'turn/end') {
    const kind = event.data?.reason?.kind
    metadata.reasonKind = ['stop', 'error', 'aborted', 'max-tokens', 'tool-calls', 'completed'].includes(kind)
      ? kind : 'unknown'
  }
  return metadata
}

/** Require no caller-controlled arguments for fixed collection operations. */
function noArguments(request) {
  if (Object.keys(request).some(key => key !== 'token' && key !== 'op')) {
    throw new Error('invalid_request')
  }
}

/** Call one explicitly listed read operation; no dynamic method dispatch is possible. */
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
