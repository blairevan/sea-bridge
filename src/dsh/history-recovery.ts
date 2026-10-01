import type { DshEventMetadata, DshHistoryPage } from "./types.ts";

export interface DshRecoveryLimits {
  maxEvents?: number;
  maxPages?: number;
}

export interface DshRecoveredHistory {
  events: DshEventMetadata[];
  pages: number;
}

/** Rebuild every event in (fromSeq, throughSeq] from bounded backward pages, rejecting any gap. */
export async function recoverDshHistory(
  fromSeq: number,
  throughSeq: number,
  readPage: (beforeSeq?: number) => Promise<DshHistoryPage>,
  limits: DshRecoveryLimits = {},
): Promise<DshRecoveredHistory> {
  const maxEvents = limits.maxEvents ?? 256;
  const maxPages = limits.maxPages ?? 32;
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 ||
    !Number.isSafeInteger(maxPages) || maxPages < 1 ||
    !Number.isSafeInteger(fromSeq) || !Number.isSafeInteger(throughSeq) ||
    fromSeq < -1 || throughSeq < fromSeq || throughSeq - fromSeq > maxEvents) {
    throw new Error("invalid_recovery_interval");
  }
  if (fromSeq === throughSeq) return { events: [], pages: 0 };

  const descending: DshEventMetadata[] = [];
  let expected = throughSeq;
  let beforeSeq: number | undefined;
  let pages = 0;
  while (expected > fromSeq && pages < maxPages) {
    const page = await readPage(beforeSeq);
    pages++;
    if (page.truncated || page.events.length === 0) throw new Error("recovery_page_unavailable");
    const events = page.events;
    if (events.at(-1)?.seq !== expected) throw new Error("recovery_gap");
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index];
      if (!event || !Number.isSafeInteger(event.seq) || event.seq !== expected) {
        throw new Error("recovery_gap");
      }
      if (event.seq > fromSeq) descending.push(event);
      expected--;
    }
    if (expected <= fromSeq) break;
    if (!page.hasMore) throw new Error("recovery_exhausted");
    beforeSeq = events[0]?.seq;
  }
  if (expected > fromSeq) throw new Error("recovery_page_limit");
  return { events: descending.reverse(), pages };
}
