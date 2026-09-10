import fs from 'node:fs'
import path from 'node:path'

import type { DshContext } from './dsh-types.ts'
import type { MemoryDatabase } from './db.ts'
import type { MemoryPaths } from './paths.ts'
import type { MemoryPluginConfig } from './config.ts'
import type { StatusWriter } from './settings.ts'
import { runPhase1 } from './phase1.ts'
import { runPhase2, ensureWorkspaceSkeleton } from './phase2.ts'

export interface SchedulerStats {
  lastCycleAt: number | null
  lastError: string | null
  /** Called after every completed cycle (viewer refresh hook). */
  onCycleEnd?: () => void
}

export interface SchedulerHandle {
  /** Run one full memory cycle immediately (widget action). */
  requestCycle(): void
}

/**
 * Background scheduler: a fixed interval plus an idle-status debounce drive the
 * same serialized cycle — retention prune, Phase 1 over eligible sessions,
 * Phase 2 consolidation.
 */
export function startScheduler(
  ctx: DshContext,
  db: MemoryDatabase,
  paths: MemoryPaths,
  config: MemoryPluginConfig,
  status: StatusWriter,
  stats: SchedulerStats,
): SchedulerHandle {
  let running = false
  let idleTimer: NodeJS.Timeout | null = null

  const runCycle = async (trigger: string): Promise<void> => {
    if (running) return
    if (!config.enabled || !config.generateMemories) return
    running = true
    // A fresh process always attempts Phase 2 once (a failed job's backoff
    // must not survive a restart); interval cycles keep the backoff.
    const startup = trigger === 'startup'
    try {
      await ensureWorkspaceSkeleton(paths)
      db.resetFailedPhase1Jobs()
      const pruned = db.pruneStage1ForRetention(config.maxUnusedDays)
      if (pruned > 0) {
        console.info(`[dsh-memory] pruned ${pruned} expired stage-1 rows`)
      }
      // Translation memory is a cache: entries no artifact used in 90 days go.
      db.pruneTranslationSegments(90)
      status('phase1', `scanning sessions (${trigger})`)
      const phase1 = await runPhase1(ctx, db, paths, config)
      console.info(
        `[dsh-memory] phase1(${trigger}): candidates=${phase1.candidates} extracted=${phase1.extracted}`
          + ` noOutput=${phase1.noOutput} failed=${phase1.failed} skipped=${phase1.skipped}`,
      )
      let phase2Note = ''
      let summaryPreview: string | undefined
      // Phase 2 runs whenever consolidation candidates exist (new extractions
      // from this cycle OR rows left unconsolidated by an earlier failed run),
      // gated by the success cooldown. With zero candidates the runner still
      // checks for ad-hoc note changes (note-only consolidations) and reports
      // `no-changes` cheaply. Startup runs ignore the retry backoff.
      const pending = db.listPhase2Candidates(config.maxUnusedDays).length
      if (!startup || config.runPhase2OnStartup) {
        const cooldown = db.phase2CooldownUntil(config.phase2SuccessCooldownSeconds)
        if (cooldown == null || cooldown <= Math.floor(Date.now() / 1000)) {
          status('phase2', `consolidating ${pending} record(s)`)
          const phase2 = await runPhase2(ctx, db, paths, config, { ignoreRetryAt: startup })
          console.info(`[dsh-memory] phase2: ran=${phase2.ran}${phase2.reason ? ` reason=${phase2.reason}` : ''}`)
          if (phase2.ran) {
            phase2Note = `, consolidated ${pending}`
            summaryPreview = phase2.summaryPreview
          }
        }
      }
      const summary = phase1.extracted > 0
        ? `extracted ${phase1.extracted}, skipped ${phase1.skipped}${phase2Note}`
        : pending > 0 && phase2Note !== ''
          ? `consolidated ${pending}`
          : `no new memories (skipped ${phase1.skipped})`
      status('idle', summary, summaryPreview)
      stats.lastCycleAt = Date.now()
      stats.lastError = null
      stats.onCycleEnd?.()
    } catch (error) {
      stats.lastError = String(error)
      status('idle', `last run failed: ${String(error).slice(0, 200)}`)
      console.warn('[dsh-memory] memory cycle failed:', error)
    } finally {
      running = false
    }
  }

  const debouncedCycle = (): void => {
    if (idleTimer != null) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      idleTimer = null
      void runCycle('idle')
    }, 5_000)
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      void runCycle('interval')
    }, Math.max(1, config.scanIntervalMinutes) * 60_000)
    queueMicrotask(() => {
      void runCycle('startup')
    })
    return () => {
      clearInterval(timer)
      if (idleTimer != null) clearTimeout(idleTimer)
    }
  })

  ctx.on('agent/status', (payload: { status?: string }) => {
    if (payload?.status === 'idle') debouncedCycle()
  })

  return {
    requestCycle: () => {
      void runCycle('manual')
    },
  }
}

/** Head of memory_summary.md for the widget preview. */
export function summaryPreviewHead(paths: MemoryPaths, chars = 700): string | undefined {
  try {
    const text = fs.readFileSync(path.join(paths.workspaceRoot, 'memory_summary.md'), 'utf8').trim()
    if (text === '') return undefined
    return text.length > chars ? `${text.slice(0, chars)}…` : text
  } catch {
    return undefined
  }
}
