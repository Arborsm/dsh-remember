import type { DshContext, SessionEvent } from './dsh-types.ts'
import type { MemoryDatabase } from './db.ts'

const CITATION_BLOCK = /<dsh-mem-citation>([\s\S]*?)<\/dsh-mem-citation>/gu
const ENTRIES_SECTION = /<citation_entries>([\s\S]*?)<\/citation_entries>/u
const IDS_SECTION = /<rollout_ids>([\s\S]*?)<\/rollout_ids>/u

export interface MemoryCitation {
  entries: Array<{ path: string; lineStart?: number; lineEnd?: number; note?: string }>
  rolloutIds: string[]
}

/** Parse the citation block format documented in the read-path reminder. */
export function parseMemoryCitation(text: string): MemoryCitation | null {
  const block = [...text.matchAll(CITATION_BLOCK)].at(-1)?.[1]
  if (block == null) return null
  const entries: MemoryCitation['entries'] = []
  const entriesMatch = ENTRIES_SECTION.exec(block)
  if (entriesMatch?.[1] != null) {
    for (const line of entriesMatch[1].split(/\r?\n/u)) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const [loc, ...noteParts] = trimmed.split('|')
      const [filePath, range] = (loc ?? '').split(':')
      if (!filePath) continue
      const [lineStart, lineEnd] = (range ?? '').split('-').map((value) => Number.parseInt(value, 10))
      const note = noteParts.join('|').replace(/^note=/u, '').trim() || undefined
      entries.push({
        path: filePath.trim(),
        lineStart: Number.isFinite(lineStart) ? lineStart : undefined,
        lineEnd: Number.isFinite(lineEnd) ? lineEnd : undefined,
        note,
      })
    }
  }
  const rolloutIds: string[] = []
  const idsMatch = IDS_SECTION.exec(block)
  if (idsMatch?.[1] != null) {
    for (const line of idsMatch[1].split(/\r?\n/u)) {
      const id = line.trim()
      if (id !== '') rolloutIds.push(id)
    }
  }
  if (entries.length === 0 && rolloutIds.length === 0) return null
  return { entries, rolloutIds }
}

/**
 * Citation feedback loop: assistant messages that cite memory files bump the
 * matching stage-1 rows' usage counters, which biases future Phase 2 candidate
 * ordering and retention.
 */
export function registerCitationLoop(ctx: DshContext, db: MemoryDatabase): void {
  ctx.on('session/event', (session: unknown, event: SessionEvent) => {
    void session
    if (event?.type !== 'assistant/message') return
    const message = event.data.message
    if (message == null) return
    const text = (message.content ?? [])
      .map((block) => (block?.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
    if (!text.includes('<dsh-mem-citation>')) return
    const citation = parseMemoryCitation(text)
    if (citation == null) return
    const paths = citation.entries.map((entry) => entry.path)
    try {
      db.recordCitationUsage(citation.rolloutIds, paths)
    } catch (error) {
      console.warn('[dsh-memory] failed to record citation usage:', error)
    }
  })
}
