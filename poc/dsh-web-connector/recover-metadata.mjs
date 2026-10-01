/** Bounded read-only recovery of an exact numeric event interval. */

/** Recover every seq in (fromSeq, throughSeq] by walking backwards-only Host pages. */
export async function recoverMetadata(fromSeq, throughSeq, readPage) {
  if (!Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(throughSeq) ||
    fromSeq < -1 || throughSeq < fromSeq || throughSeq - fromSeq > 32) {
    throw new Error('invalid_recovery_interval')
  }
  if (fromSeq === throughSeq) return { fromSeq, throughSeq, count: 0, pages: 0 }
  let beforeSeq
  let expectedLast = throughSeq
  let pages = 0
  let count = 0
  while (pages < 8 && expectedLast > fromSeq) {
    const page = await readPage(beforeSeq)
    pages++
    if (!page?.ok || page.truncated || !Array.isArray(page.events) || page.events.length === 0) {
      throw new Error('recovery_page_unavailable')
    }
    const events = page.events
    if (events.at(-1).seq !== expectedLast) throw new Error('recovery_gap')
    for (let index = events.length - 1; index >= 0; index--) {
      const seq = events[index].seq
      if (!Number.isSafeInteger(seq) || seq !== expectedLast) throw new Error('recovery_gap')
      if (seq > fromSeq) count++
      expectedLast--
    }
    if (expectedLast <= fromSeq) break
    if (page.hasMore !== true) throw new Error('recovery_exhausted')
    beforeSeq = events[0].seq
  }
  if (expectedLast > fromSeq) throw new Error('recovery_page_limit')
  return { fromSeq, throughSeq, count, pages }
}
