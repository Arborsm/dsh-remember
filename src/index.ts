import { exec } from 'node:child_process'
import path from 'node:path'

import { MemoryDatabase } from './db.ts'
import type { DshContext } from './dsh-types.ts'
import { resolveMemoryPaths, type MemoryPaths } from './paths.ts'
import { Config, type MemoryPluginConfig } from './config.ts'
import { registerCitationLoop } from './citations.ts'
import { registerReadPath } from './read-path.ts'
import { startScheduler, type SchedulerHandle } from './scheduler.ts'
import { installMemorySettings, installMemoryStatus, installMemoryView, type StatusWriter, type ViewWriter } from './settings.ts'
import { buildExportBundle, importBundle, registerTransferTools, writeExportBundle } from './transfer.ts'
import { publishMemoryView, translateMemory } from './view.ts'

export const name = 'dsh-memory-plugin'

export const inject = [
  'tools',
  'llm',
  'systemPrompt',
  'agents',
  'sessionPersistence',
  'agentDefaultModel',
]

export { Config }

export function apply(ctx: DshContext, config: MemoryPluginConfig): void {
  const paths: MemoryPaths = resolveMemoryPaths(config)
  const db = new MemoryDatabase(paths.dbPath)
  ctx.effect(() => () => db[Symbol.dispose]())

  console.info(
    `[dsh-memory] loaded: workspace=${paths.workspaceRoot} db=${paths.dbPath}`
      + ` generate=${config.generateMemories} use=${config.useMemories}`,
  )

  if (!config.enabled) {
    console.info('[dsh-memory] disabled by config; nothing registered')
    return
  }

  // Web settings page + processing status channel (both degrade gracefully
  // when the settings provider is absent from the composition).
  installMemorySettings(ctx, config)
  const memoryStatus = installMemoryStatus(ctx)
  const viewWriter = installMemoryView(ctx)
  const refreshView = (): void => {
    try {
      publishMemoryView(db, paths, viewWriter)
    } catch (error) {
      console.warn('[dsh-memory] view publish failed:', error)
    }
  }
  let schedulerHandle: SchedulerHandle | null = null
  memoryStatus.onCommand((action, argPath, arg, force) => {
    switch (action) {
      case 'run-cycle':
        schedulerHandle?.requestCycle()
        break
      case 'toggle-schedule': {
        config.generateMemories = !config.generateMemories
        console.info(`[dsh-memory] scheduling ${config.generateMemories ? 'resumed' : 'paused'} (runtime)`)
        break
      }
      case 'open-folder':
        exec(`explorer "${paths.workspaceRoot}"`, () => {})
        break
      case 'export':
      case 'import':
        void runTransfer(action, argPath, db, paths, memoryStatus.write)
        break
      case 'refresh-view':
        refreshView()
        break
      case 'translate-memory':
        void runTranslate(arg || 'zh', force, ctx, db, paths, config, viewWriter, memoryStatus.write)
        break
      default:
        console.warn(`[dsh-memory] unknown widget command: ${action}`)
    }
  })

  if (config.useMemories) {
    registerReadPath(ctx, paths, config)
  }

  registerCitationLoop(ctx, db)
  registerTransferTools(ctx.tools, db, paths)
  schedulerHandle = startScheduler(ctx, db, paths, config, memoryStatus.write, {
    lastCycleAt: null,
    lastError: null,
    onCycleEnd: refreshView,
  })
  refreshView()
}

/** Translate the memory artifacts (translation memory, optionally rebuilt); outcomes land in the view namespace. */
async function runTranslate(
  lang: string,
  force: boolean,
  ctx: DshContext,
  db: MemoryDatabase,
  paths: MemoryPaths,
  config: MemoryPluginConfig,
  view: ViewWriter,
  status: StatusWriter,
): Promise<void> {
  view({ translating: true })
  status('idle', `translate: ${force ? 'rebuilding' : 'starting'}…`)
  try {
    const result = await translateMemory(ctx, db, paths, config, lang, {
      force,
      onProgress: ({ done, total }) => {
        // Progress rides the small status mirror: the float and the viewer show
        // it live without rewriting the big view snapshot per segment.
        status('idle', `translate: ${done}/${total} segments`)
      },
    })
    const detail = `translated ${result.translated.join(', ') || 'nothing'}`
      + `${result.cached.length > 0 ? `, cached ${result.cached.join(', ')}` : ''}`
    console.info(`[dsh-memory] memory translated (${lang}): ${detail}`)
    status('idle', `translate: ${detail}`)
  } catch (error) {
    console.warn('[dsh-memory] translate failed:', error)
    status('idle', `translate: failed: ${String(error).slice(0, 160)}`)
  } finally {
    view({ translating: false })
    try {
      publishMemoryView(db, paths, view)
    } catch {
      // publish failure is non-fatal; the status line already carried the result
    }
  }
}

/**
 * Settings-page transfer actions. Outcomes land in the status namespace detail
 * (prefix `transfer:`), which the page renders under the transfer group.
 */
async function runTransfer(
  direction: 'export' | 'import',
  rawPath: string,
  db: MemoryDatabase,
  paths: MemoryPaths,
  status: StatusWriter,
): Promise<void> {
  const trimmed = rawPath.trim()
  if (trimmed === '') {
    status('idle', `transfer: ${direction} needs a bundle directory path`)
    return
  }
  const target = path.resolve(trimmed)
  try {
    if (direction === 'export') {
      if (target === paths.workspaceRoot || target.startsWith(paths.workspaceRoot + path.sep)) {
        status('idle', 'transfer: export destination must be outside the memory workspace')
        return
      }
      const manifest = writeExportBundle(buildExportBundle(paths, db, 'dsh-web'), target)
      console.info(`[dsh-memory] exported ${manifest.recordCount} records, ${manifest.fileCount} files -> ${target}`)
      status('idle', `transfer: exported ${manifest.recordCount} records and ${manifest.fileCount} files to ${target}`)
    } else {
      const outcome = await importBundle(target, db, paths)
      console.info(`[dsh-memory] imported ${outcome.imported} records (${outcome.duplicate} duplicates) from ${target}`)
      status('idle',
        `transfer: imported ${outcome.imported} records, ${outcome.filesImported} files`
          + ` (${outcome.duplicate} duplicates skipped, ${outcome.targetWins} conflicts kept local)`)
    }
  } catch (error) {
    console.warn(`[dsh-memory] transfer ${direction} failed:`, error)
    status('idle', `transfer: ${direction} failed: ${String(error).slice(0, 160)}`)
  }
}
