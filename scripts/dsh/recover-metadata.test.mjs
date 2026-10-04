import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { recoverMetadata } from './recover-metadata.mjs'

/** Build one synthetic, metadata-only event page. */
function page(seqs, hasMore = false) {
  return { ok: true, events: seqs.map(seq => ({ seq, type: 'test/event', time: 1 })),
    hasMore, truncated: false }
}

test('reconstructs an exact interval across backward pages', async () => {
  const calls = []
  const result = await recoverMetadata(1, 6, async beforeSeq => {
    calls.push(beforeSeq)
    return beforeSeq === undefined ? page([4, 5, 6], true) : page([1, 2, 3])
  })
  assert.deepEqual(calls, [undefined, 4])
  assert.deepEqual(result, { fromSeq: 1, throughSeq: 6, count: 5, pages: 2 })
})

test('fails closed on a missing seq or truncated page', async () => {
  await assert.rejects(recoverMetadata(1, 6, async () => page([3, 5, 6])), /recovery_gap/)
  await assert.rejects(recoverMetadata(1, 6, async () => ({ ...page([4, 5, 6]), truncated: true })),
    /recovery_page_unavailable/)
})
