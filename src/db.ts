import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Durable memory store: stage-1 outputs plus the two-phase job queue.
 *
 * Store semantics: leases with ownership tokens, watermark-guarded upserts,
 * exponential retry backoff, a global Phase 2 success cooldown, and retention
 * pruning. All timestamps are Unix seconds.
 */

export const MEMORY_STAGE1_SCHEMA_VERSION = 'dsh-memory.stage1.v1'

export interface MemoryRecord {
  sessionId: string
  workspacePath: string
  rolloutPath: string
  sourceUpdatedAt: number
  rawMemory: string
  rolloutSummary: string
  rolloutSlug: string | null
  generatedAt: number
  usageCount: number
  lastUsage: number | null
  selectedForPhase2: boolean
  selectedForPhase2SourceUpdatedAt: number | null
}

export interface MemoryJobRecord {
  kind: string
  jobKey: string
  status: string
  workerId: string | null
  ownershipToken: string | null
  startedAt: number | null
  finishedAt: number | null
  leaseUntil: number | null
  retryAt: number | null
  retryRemaining: number
  lastError: string | null
  inputWatermark: number | null
  lastSuccessWatermark: number | null
}

export interface Phase2Candidate {
  sessionId: string
  workspacePath: string
  rolloutPath: string
  sourceUpdatedAt: number
  rawMemory: string
  rolloutSummary: string
  rolloutSlug: string | null
  generatedAt: number
  usageCount: number
  lastUsage: number | null
}

export interface Phase1Claim {
  claimed: boolean
  token: string
  /** Present when not claimed: the human-readable reason. */
  reason?: string
  previousSourceUpdatedAt?: number | null
}

export interface Phase2Claim {
  claimed: boolean
  token: string
  reason?: string
}

const JOB_KIND_PHASE1 = 'memory_stage1'
const JOB_KIND_PHASE2_GLOBAL = 'memory_consolidate_global'
const JOB_STATUS_PENDING = 'pending'
const JOB_STATUS_RUNNING = 'running'
const JOB_STATUS_DONE = 'done'
const JOB_STATUS_FAILED = 'failed'

function nowSecs(): number {
  return Math.floor(Date.now() / 1000)
}

/** Split a list into fixed-size batches (SQLite parameter limits). */
function chunked<T>(items: T[], size: number): T[][] {
  const batches: T[][] = []
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size))
  }
  return batches
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .split('\n').map((line) => line.replace(/[ \t]+$/u, '')).join('\n').replace(/\n+$/u, '')
}

export function recordContentHash(record: Pick<MemoryRecord, 'rawMemory' | 'rolloutSummary'>): string {
  // Normalized-content hash used to dedupe imported records.
  // eslint-disable-next-line no-bitwise -- FNV-1a keeps this dependency-free.
  let hash = 0x811c9dc5
  const input = `${normalizeText(record.rawMemory)}\u0000${normalizeText(record.rolloutSummary)}`
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export class MemoryDatabase implements Disposable {
  private readonly db: DatabaseSync
  private readonly file: string

  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    this.file = dbPath
    this.db = new DatabaseSync(dbPath)
    this.db.exec('PRAGMA journal_mode = WAL;')
    this.db.exec('PRAGMA busy_timeout = 5000;')
    this.db.exec('PRAGMA synchronous = NORMAL;')
    this.initializeSchema()
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS stage1_outputs (
        thread_id TEXT PRIMARY KEY NOT NULL,
        workspace_path TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        source_updated_at INTEGER NOT NULL,
        raw_memory TEXT NOT NULL,
        rollout_summary TEXT NOT NULL,
        rollout_slug TEXT,
        generated_at INTEGER NOT NULL,
        usage_count INTEGER,
        last_usage INTEGER,
        selected_for_phase2 INTEGER NOT NULL DEFAULT 0,
        selected_for_phase2_source_updated_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_stage1_outputs_source_updated_at
        ON stage1_outputs(source_updated_at DESC, thread_id DESC);

      CREATE TABLE IF NOT EXISTS jobs (
        kind TEXT NOT NULL,
        job_key TEXT NOT NULL,
        status TEXT NOT NULL,
        worker_id TEXT,
        ownership_token TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        lease_until INTEGER,
        retry_at INTEGER,
        retry_remaining INTEGER NOT NULL,
        last_error TEXT,
        input_watermark INTEGER,
        last_success_watermark INTEGER,
        PRIMARY KEY (kind, job_key)
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_kind_status_retry_lease
        ON jobs(kind, status, retry_at, lease_until);

      -- Translation memory: one row per source segment, so an edit re-translates
      -- only the segment it touched instead of the whole artifact.
      CREATE TABLE IF NOT EXISTS translation_segments (
        hash TEXT NOT NULL,
        lang TEXT NOT NULL,
        source TEXT NOT NULL,
        translated TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (hash, lang)
      );

      CREATE INDEX IF NOT EXISTS idx_translation_segments_updated_at
        ON translation_segments(updated_at);
    `)
  }

  close(): void {
    this.db.close()
  }

  [Symbol.dispose](): void {
    try {
      this.db.close()
    } catch {
      // already closed
    }
  }

  /**
   * BEGIN IMMEDIATE transaction helper (node:sqlite exposes no `.transaction()`
   * on this Node line; this mirrors the lease-claim transaction semantics).
   */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // connection-level failure; nothing to roll back
      }
      throw error
    }
  }

  // ── stage1_outputs ────────────────────────────────────────────────────────

  getStage1(sessionId: string): MemoryRecord | undefined {
    const row = this.db.prepare(
      `SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
              rollout_summary, rollout_slug, generated_at, COALESCE(usage_count, 0) AS usage_count,
              last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
       FROM stage1_outputs WHERE thread_id = ?`,
    ).get(sessionId)
    return row ? decodeRecord(row) : undefined
  }

  listStage1(): MemoryRecord[] {
    const rows = this.db.prepare(
      `SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
              rollout_summary, rollout_slug, generated_at, COALESCE(usage_count, 0) AS usage_count,
              last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
       FROM stage1_outputs ORDER BY thread_id`,
    ).all()
    return rows.map(decodeRecord)
  }

  /**
   * Watermark-guarded upsert: a row is only replaced when the incoming
   * `source_updated_at` is at least as fresh as the stored one.
   */
  upsertStage1(record: MemoryRecord, overwriteUsageAndSelection: boolean): void {
    const overwrite = overwriteUsageAndSelection ? 1 : 0
    this.db.prepare(
      `INSERT INTO stage1_outputs (
         thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
         rollout_summary, rollout_slug, generated_at, usage_count,
         last_usage, selected_for_phase2, selected_for_phase2_source_updated_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(thread_id) DO UPDATE SET
         workspace_path = excluded.workspace_path,
         rollout_path = excluded.rollout_path,
         source_updated_at = excluded.source_updated_at,
         raw_memory = excluded.raw_memory,
         rollout_summary = excluded.rollout_summary,
         rollout_slug = excluded.rollout_slug,
         generated_at = excluded.generated_at,
         usage_count = CASE
           WHEN ? != 0 THEN excluded.usage_count
           ELSE stage1_outputs.usage_count
         END,
         last_usage = CASE
           WHEN ? != 0 THEN excluded.last_usage
           ELSE stage1_outputs.last_usage
         END,
         selected_for_phase2 = CASE
           WHEN ? != 0 THEN excluded.selected_for_phase2
           ELSE stage1_outputs.selected_for_phase2
         END,
         selected_for_phase2_source_updated_at = CASE
           WHEN ? != 0 THEN excluded.selected_for_phase2_source_updated_at
           ELSE stage1_outputs.selected_for_phase2_source_updated_at
         END
       WHERE excluded.source_updated_at >= stage1_outputs.source_updated_at`,
    ).run(
      record.sessionId,
      record.workspacePath,
      record.rolloutPath,
      record.sourceUpdatedAt,
      record.rawMemory,
      record.rolloutSummary,
      record.rolloutSlug,
      record.generatedAt,
      record.usageCount,
      record.lastUsage,
      record.selectedForPhase2 ? 1 : 0,
      record.selectedForPhase2SourceUpdatedAt,
      overwrite,
      overwrite,
      overwrite,
      overwrite,
    )
  }

  /** Citation feedback: bump usage counters for the referenced sessions. */
  recordCitationUsage(rolloutIds: string[], referencedPaths: string[]): number {
    const ids = [...new Set([...rolloutIds, ...referencedPaths])].filter((id) => id.trim() !== '')
    if (ids.length === 0) return 0
    const now = nowSecs()
    let updated = 0
    for (const id of ids) {
      const result = this.db.prepare(
        `UPDATE stage1_outputs
         SET usage_count = COALESCE(usage_count, 0) + 1, last_usage = ?
         WHERE thread_id = ? OR rollout_slug = ? OR rollout_path = ?`,
      ).run(now, id, id, id)
      updated += Number(result.changes)
    }
    return updated
  }

  /** Retention pruning: drop unselected rows unused for too long (batched). */
  pruneStage1ForRetention(maxUnusedDays: number, batchSize = 200): number {
    const cutoff = nowSecs() - Math.floor(maxUnusedDays * 86400)
    const result = this.db.prepare(
      `DELETE FROM stage1_outputs
       WHERE thread_id IN (
         SELECT thread_id FROM stage1_outputs
         WHERE selected_for_phase2 = 0
           AND COALESCE(last_usage, generated_at, source_updated_at) < ?
         LIMIT ?
       )`,
    ).run(cutoff, batchSize)
    return Number(result.changes)
  }

  // ── Phase 1 job acquisition ───────────────────────────────────────────────

  tryClaimPhase1Job(sessionId: string, inputWatermark: number, leaseSeconds: number, maxRetries: number): Phase1Claim {
    const now = nowSecs()
    const token = randomUUID()
    return this.tx(() => {
      const existing = this.getJob(JOB_KIND_PHASE1, sessionId)
      if (existing) {
        if (existing.lastSuccessWatermark != null && existing.lastSuccessWatermark >= inputWatermark) {
          return { claimed: false, token: '', reason: 'watermark-current' }
        }
        if (existing.leaseUntil != null && existing.leaseUntil > now && existing.status === JOB_STATUS_RUNNING) {
          return { claimed: false, token: '', reason: 'lease-active' }
        }
        if (existing.retryAt != null && existing.retryAt > now && existing.status !== JOB_STATUS_RUNNING) {
          return { claimed: false, token: '', reason: 'retry-scheduled' }
        }
        const retryRemaining = existing.status === JOB_STATUS_DONE || existing.lastError == null
          ? maxRetries
          : existing.retryRemaining
        this.db.prepare(
          `UPDATE jobs SET status = ?, worker_id = ?, ownership_token = ?, started_at = ?,
                  finished_at = NULL, lease_until = ?, retry_at = NULL, retry_remaining = ?,
                  last_error = NULL, input_watermark = ?
           WHERE kind = ? AND job_key = ?`,
        ).run(JOB_STATUS_RUNNING, workerId(), token, now, now + leaseSeconds, retryRemaining, inputWatermark, JOB_KIND_PHASE1, sessionId)
        return {
          claimed: true,
          token,
          previousSourceUpdatedAt: existing.inputWatermark,
        }
      }
      this.db.prepare(
        `INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at,
                           lease_until, retry_remaining, input_watermark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(JOB_KIND_PHASE1, sessionId, JOB_STATUS_RUNNING, workerId(), token, now, now + leaseSeconds, maxRetries, inputWatermark)
      return { claimed: true, token }
    }) as Phase1Claim
  }

  markPhase1Succeeded(sessionId: string, token: string, record: MemoryRecord): void {
    const now = nowSecs()
    this.tx(() => {
      this.upsertStage1(record, false)
      this.db.prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, ownership_token = NULL,
                last_error = NULL, last_success_watermark = input_watermark, retry_remaining = ?
         WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
      ).run(JOB_STATUS_DONE, now, maxRetriesConstant(), JOB_KIND_PHASE1, sessionId, token)
    })
  }

  /** Successful run with no extractable output: clear any stale row. */
  markPhase1SucceededNoOutput(sessionId: string, token: string): void {
    const now = nowSecs()
    this.tx(() => {
      this.db.prepare('DELETE FROM stage1_outputs WHERE thread_id = ? AND selected_for_phase2 = 0').run(sessionId)
      this.db.prepare(
        `UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, ownership_token = NULL,
                last_error = NULL, last_success_watermark = input_watermark
         WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
      ).run(JOB_STATUS_DONE, now, JOB_KIND_PHASE1, sessionId, token)
    })
  }

  markPhase1Failure(sessionId: string, token: string, error: string, backoffMinutes: number): void {
    const now = nowSecs()
    this.tx(() => {
      const job = this.getJobForOwner(JOB_KIND_PHASE1, sessionId, token)
      if (!job) return
      const remaining = job.retryRemaining - 1
      if (remaining > 0) {
        const attempt = Math.max(0, maxRetriesConstant() - remaining)
        const delay = Math.floor(backoffMinutes * 60 * 2 ** attempt)
        this.db.prepare(
          `UPDATE jobs SET status = ?, retry_at = ?, retry_remaining = ?, lease_until = NULL,
                  ownership_token = NULL, last_error = ?
           WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
        ).run(JOB_STATUS_PENDING, now + delay, remaining, error, JOB_KIND_PHASE1, sessionId, token)
      } else {
        this.db.prepare(
          `UPDATE jobs SET status = ?, finished_at = ?, retry_remaining = 0, lease_until = NULL,
                  ownership_token = NULL, last_error = ?
           WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
        ).run(JOB_STATUS_FAILED, now, error, JOB_KIND_PHASE1, sessionId, token)
      }
    })
  }

  /** Requeue sessions whose last extraction attempt failed but may succeed later. */
  resetFailedPhase1Jobs(): void {
    this.db.prepare(
      `UPDATE jobs SET status = ?, retry_at = NULL, retry_remaining = ?
       WHERE kind = ? AND status = ? AND last_success_watermark IS NULL`,
    ).run(JOB_STATUS_PENDING, maxRetriesConstant(), JOB_KIND_PHASE1, JOB_STATUS_FAILED)
  }

  // ── Phase 2 global job ────────────────────────────────────────────────────

  phase2CooldownUntil(cooldownSeconds: number): number | null {
    const job = this.getJob(JOB_KIND_PHASE2_GLOBAL, 'global')
    if (!job) return null
    if (
      job.kind !== JOB_KIND_PHASE2_GLOBAL
      || job.status !== JOB_STATUS_DONE
      || job.lastError != null
      || job.lastSuccessWatermark == null
    ) {
      return null
    }
    // Cooldown only holds while nothing new arrived since the last success: a
    // fresher source watermark breaks it immediately (the stored success
    // watermark must still equal the current max, evaluated live).
    if (job.lastSuccessWatermark !== this.maxSourceUpdatedAt()) return null
    if (job.finishedAt == null) return null
    return job.finishedAt + Math.max(0, cooldownSeconds)
  }

  tryClaimPhase2Job(leaseSeconds: number, ignoreRetryAt = false): Phase2Claim {
    const now = nowSecs()
    const token = randomUUID()
    return this.tx(() => {
      const existing = this.getJob(JOB_KIND_PHASE2_GLOBAL, 'global')
      if (existing) {
        if (existing.leaseUntil != null && existing.leaseUntil > now && existing.status === JOB_STATUS_RUNNING) {
          return { claimed: false, token: '', reason: 'lease-active' }
        }
        if (!ignoreRetryAt && existing.retryAt != null && existing.retryAt > now && existing.status !== JOB_STATUS_RUNNING) {
          return { claimed: false, token: '', reason: 'retry-scheduled' }
        }
        this.db.prepare(
          `UPDATE jobs SET status = ?, worker_id = ?, ownership_token = ?, started_at = ?,
                  finished_at = NULL, lease_until = ?, retry_at = NULL, last_error = NULL
           WHERE kind = ? AND job_key = ?`,
        ).run(JOB_STATUS_RUNNING, workerId(), token, now, now + leaseSeconds, JOB_KIND_PHASE2_GLOBAL, 'global')
        return { claimed: true, token }
      }
      this.db.prepare(
        `INSERT INTO jobs (kind, job_key, status, worker_id, ownership_token, started_at,
                           lease_until, retry_remaining)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(JOB_KIND_PHASE2_GLOBAL, 'global', JOB_STATUS_RUNNING, workerId(), token, now, now + leaseSeconds, 3)
      return { claimed: true, token }
    }) as Phase2Claim
  }

  heartbeatPhase2(token: string, leaseSeconds: number): void {
    const now = nowSecs()
    this.db.prepare(
      `UPDATE jobs SET lease_until = ? WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
    ).run(now + leaseSeconds, JOB_KIND_PHASE2_GLOBAL, 'global', token)
  }

  markPhase2Succeeded(token: string, inputWatermark: number): void {
    const now = nowSecs()
    this.db.prepare(
      `UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, ownership_token = NULL,
              last_error = NULL, last_success_watermark = ?, input_watermark = ?
       WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
    ).run(JOB_STATUS_DONE, now, inputWatermark, inputWatermark, JOB_KIND_PHASE2_GLOBAL, 'global', token)
  }

  markPhase2Failure(token: string, error: string): void {
    const now = nowSecs()
    this.db.prepare(
      `UPDATE jobs SET status = ?, finished_at = ?, lease_until = NULL, ownership_token = NULL,
              last_error = ?, retry_at = ?
       WHERE kind = ? AND job_key = ? AND ownership_token = ?`,
    ).run(JOB_STATUS_FAILED, now, error, now + 300, JOB_KIND_PHASE2_GLOBAL, 'global', token)
  }

  // ── Phase 2 candidate selection ───────────────────────────────────────────

  /**
   * Candidates for consolidation: usage first, then recency, with a freshness
   * cutoff. Previously selected rows ARE included — new content for an
   * already-consolidated session must re-enter consolidation. The
   * `selected_for_phase2 = 0` filter belongs to the display query, not here.
   */
  listPhase2Candidates(maxUnusedDays: number, limit = 4096): Phase2Candidate[] {
    const cutoff = nowSecs() - Math.max(0, Math.floor(maxUnusedDays)) * 86400
    const rows = this.db.prepare(
      `SELECT thread_id, workspace_path, rollout_path, source_updated_at, raw_memory,
              rollout_summary, rollout_slug, generated_at, COALESCE(usage_count, 0) AS usage_count, last_usage
       FROM stage1_outputs
       WHERE (length(trim(raw_memory)) > 0 OR length(trim(rollout_summary)) > 0)
         AND COALESCE(last_usage, source_updated_at) >= ?
       ORDER BY usage_count DESC, COALESCE(last_usage, source_updated_at) DESC, source_updated_at DESC, thread_id DESC
       LIMIT ?`,
    ).all(cutoff, limit)
    return rows.map((row) => {
      const record = decodeRecord(row)
      return {
        sessionId: record.sessionId,
        workspacePath: record.workspacePath,
        rolloutPath: record.rolloutPath,
        sourceUpdatedAt: record.sourceUpdatedAt,
        rawMemory: record.rawMemory,
        rolloutSummary: record.rolloutSummary,
        rolloutSlug: record.rolloutSlug,
        generatedAt: record.generatedAt,
        usageCount: record.usageCount,
        lastUsage: record.lastUsage,
      }
    })
  }

  listSelected(): MemoryRecord[] {
    return this.listStage1().filter((record) => record.selectedForPhase2)
  }

  /** Compact per-record stats for the web viewer (no raw_memory payload). */
  listStage1Stats(): Array<{
    sessionId: string
    workspacePath: string
    rolloutSlug: string
    sourceUpdatedAt: number
    generatedAt: number
    usageCount: number
    lastUsage: number | null
    selectedForPhase2: boolean
    rawLength: number
    summaryLength: number
  }> {
    const rows = this.db.prepare(
      `SELECT thread_id, workspace_path, rollout_slug, source_updated_at, generated_at,
              COALESCE(usage_count, 0) AS usage_count, last_usage, selected_for_phase2,
              length(raw_memory) AS raw_length, length(rollout_summary) AS summary_length
       FROM stage1_outputs
       ORDER BY COALESCE(last_usage, source_updated_at) DESC`,
    ).all() as Array<Record<string, unknown>>
    return rows.map((row) => ({
      sessionId: String(row.thread_id),
      workspacePath: String(row.workspace_path),
      rolloutSlug: String(row.rollout_slug),
      sourceUpdatedAt: Number(row.source_updated_at),
      generatedAt: Number(row.generated_at),
      usageCount: Number(row.usage_count),
      lastUsage: row.last_usage == null ? null : Number(row.last_usage),
      selectedForPhase2: Number(row.selected_for_phase2) === 1,
      rawLength: Number(row.raw_length),
      summaryLength: Number(row.summary_length),
    }))
  }

  markPhase2CandidatesSelected(sessionIds: string[], watermark: number): void {
    const now = nowSecs()
    for (const sessionId of sessionIds) {
      this.db.prepare(
        `UPDATE stage1_outputs
         SET selected_for_phase2 = 1, selected_for_phase2_source_updated_at = ?
         WHERE thread_id = ? AND source_updated_at <= ?`,
      ).run(now, sessionId, watermark)
    }
  }

  // ── Translation memory ────────────────────────────────────────────────────

  /** Cached translations for the given segment hashes (missing hashes are absent). */
  getTranslationSegments(lang: string, hashes: string[]): Map<string, string> {
    const found = new Map<string, string>()
    for (const batch of chunked(hashes, 400)) {
      if (batch.length === 0) continue
      const placeholders = batch.map(() => '?').join(', ')
      const rows = this.db.prepare(
        `SELECT hash, translated FROM translation_segments WHERE lang = ? AND hash IN (${placeholders})`,
      ).all(lang, ...batch) as Array<{ hash: string; translated: string }>
      for (const row of rows) found.set(row.hash, row.translated)
    }
    return found
  }

  /** Store new translations; used segments refresh their age so pruning drops only dead entries. */
  putTranslationSegments(
    lang: string,
    rows: Array<{ hash: string; source: string; translated: string }>,
    touched: string[],
  ): void {
    const now = nowSecs()
    this.tx(() => {
      const insert = this.db.prepare(
        `INSERT INTO translation_segments (hash, lang, source, translated, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(hash, lang) DO UPDATE SET translated = excluded.translated, updated_at = excluded.updated_at`,
      )
      for (const row of rows) insert.run(row.hash, lang, row.source, row.translated, now)
      const touch = this.db.prepare(
        `UPDATE translation_segments SET updated_at = ? WHERE lang = ? AND hash = ?`,
      )
      for (const hash of touched) touch.run(now, lang, hash)
    })
  }

  /** Drop translation-memory rows untouched for `maxAgeDays` (a cache, not user data). */
  pruneTranslationSegments(maxAgeDays: number): number {
    const cutoff = nowSecs() - Math.max(1, maxAgeDays) * 86400
    return Number(this.db.prepare('DELETE FROM translation_segments WHERE updated_at < ?').run(cutoff).changes)
  }

  maxSourceUpdatedAt(): number {
    const row = this.db.prepare('SELECT MAX(source_updated_at) AS value FROM stage1_outputs').get() as
      | { value: number | null }
      | undefined
    return row?.value ?? 0
  }

  // ── import / export support ───────────────────────────────────────────────

  jobSnapshot(): MemoryJobRecord[] {
    const rows = this.db.prepare(
      `SELECT kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
              lease_until, retry_at, retry_remaining, last_error, input_watermark,
              last_success_watermark
       FROM jobs ORDER BY kind, job_key`,
    ).all()
    return rows.map(decodeJob)
  }

  private getJob(kind: string, jobKey: string): MemoryJobRecord | undefined {
    const row = this.db.prepare(
      `SELECT kind, job_key, status, worker_id, ownership_token, started_at, finished_at,
              lease_until, retry_at, retry_remaining, last_error, input_watermark,
              last_success_watermark
       FROM jobs WHERE kind = ? AND job_key = ?`,
    ).get(kind, jobKey)
    return row ? decodeJob(row) : undefined
  }

  private getJobForOwner(kind: string, jobKey: string, token: string): MemoryJobRecord | undefined {
    const job = this.getJob(kind, jobKey)
    return job?.ownershipToken === token ? job : undefined
  }
}

function maxRetriesConstant(): number {
  // Retry budget resets on a fresh claim; the column is reset at claim time.
  return 3
}

function workerId(): string {
  return `dsh-memory-plugin-${process.pid}`
}

type RowLike = Record<string, unknown>

function decodeRecord(row: RowLike): MemoryRecord {
  return {
    sessionId: String(row.thread_id),
    workspacePath: String(row.workspace_path),
    rolloutPath: String(row.rollout_path),
    sourceUpdatedAt: Number(row.source_updated_at),
    rawMemory: String(row.raw_memory),
    rolloutSummary: String(row.rollout_summary),
    rolloutSlug: row.rollout_slug == null ? null : String(row.rollout_slug),
    generatedAt: Number(row.generated_at),
    usageCount: Number(row.usage_count ?? 0),
    lastUsage: row.last_usage == null ? null : Number(row.last_usage),
    selectedForPhase2: Number(row.selected_for_phase2) !== 0,
    selectedForPhase2SourceUpdatedAt: row.selected_for_phase2_source_updated_at == null
      ? null
      : Number(row.selected_for_phase2_source_updated_at),
  }
}

function decodeJob(row: RowLike): MemoryJobRecord {
  return {
    kind: String(row.kind),
    jobKey: String(row.job_key),
    status: String(row.status),
    workerId: row.worker_id == null ? null : String(row.worker_id),
    ownershipToken: row.ownership_token == null ? null : String(row.ownership_token),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    finishedAt: row.finished_at == null ? null : Number(row.finished_at),
    leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
    retryAt: row.retry_at == null ? null : Number(row.retry_at),
    retryRemaining: Number(row.retry_remaining ?? 0),
    lastError: row.last_error == null ? null : String(row.last_error),
    inputWatermark: row.input_watermark == null ? null : Number(row.input_watermark),
    lastSuccessWatermark: row.last_success_watermark == null ? null : Number(row.last_success_watermark),
  }
}

export { JOB_KIND_PHASE2_GLOBAL, JOB_STATUS_DONE, normalizeText }
