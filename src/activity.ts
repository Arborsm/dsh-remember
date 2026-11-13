/**
 * Phase-2 consolidation log: one JSONL line per finished run, written next to
 * the database (outside the git-tracked memory workspace). The viewer reads
 * the newest entries through the `activity` view payload.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { MemoryPaths } from './paths.ts'

export interface ConsolidationEntry {
  at: number
  result: 'consolidated' | 'no-changes' | 'failed'
  records: number
  changes: number
  staged: number
  durationMs: number
  preview: string
  error?: string
}

export function activityLogPath(paths: MemoryPaths): string {
  return path.join(path.dirname(paths.dbPath), 'consolidation-log.jsonl')
}

/** Never fatal: a log write failure must not abort the consolidation run. */
export function appendConsolidationEntry(paths: MemoryPaths, entry: ConsolidationEntry): void {
  try {
    fs.appendFileSync(activityLogPath(paths), JSON.stringify(entry) + '\n', 'utf8')
  } catch (error) {
    console.warn('[dsh-memory] activity log append failed:', error)
  }
}

/** Newest-first tail; a corrupt line is skipped, not fatal. */
export function readConsolidationLog(paths: MemoryPaths, limit = 15): ConsolidationEntry[] {
  try {
    const file = activityLogPath(paths)
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
    const entries: ConsolidationEntry[] = []
    for (const line of lines.slice(-200).reverse()) {
      try {
        const parsed = JSON.parse(line) as ConsolidationEntry
        if (typeof parsed.at === 'number' && typeof parsed.result === 'string') entries.push(parsed)
      } catch {
        // skip corrupt line
      }
      if (entries.length >= limit) break
    }
    return entries
  } catch {
    return []
  }
}
