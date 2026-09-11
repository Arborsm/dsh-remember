import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

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

export const name = 'dsh-remember'

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
  memoryStatus.onCommand((action, argPath, arg, force, payload) => {
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
        void runTransfer(action, argPath, payload, db, paths, viewWriter, memoryStatus.write)
        break
      case 'export-done':
        // The browser saved (or dismissed) the bundle; drop the handoff payload.
        viewWriter({ exportName: '', exportData: '', exportAt: 0 })
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
 * Settings-page transfer actions. Picker mode: export publishes the bundle
 * base64+gzip into the view namespace (the browser shows a save dialog), import
 * arrives the same way via the command payload and is staged to a temp file.
 * A non-empty path keeps the legacy straight-to-disk behavior (model tools,
 * dev). Outcomes land in the status namespace detail (prefix `transfer:`).
 */
async function runTransfer(
  direction: 'export' | 'import',
  rawPath: string,
  payload: string,
  db: MemoryDatabase,
  paths: MemoryPaths,
  view: ViewWriter,
  status: StatusWriter,
): Promise<void> {
  const trimmed = rawPath.trim()
  try {
    if (direction === 'export') {
      const bundle = buildExportBundle(paths, db, 'dsh-web')
      if (trimmed === '') {
        const data = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')).toString('base64')
        const stamp = new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')
        view({ exportName: `dsh-memory-${stamp}.dshmem`, exportData: data, exportAt: Date.now() })
        status('idle', `transfer: exported ${bundle.records.length} records — choose where to save the bundle`)
        return
      }
      const target = path.resolve(trimmed)
      if (target === paths.workspaceRoot || target.startsWith(paths.workspaceRoot + path.sep)) {
        status('idle', 'transfer: export destination must be outside the memory workspace')
        return
      }
      const manifest = writeExportBundle(bundle, target)
      console.info(`[dsh-memory] exported ${manifest.recordCount} records, ${manifest.fileCount} files -> ${target}`)
      status('idle', `transfer: exported ${manifest.recordCount} records and ${manifest.fileCount} files to ${target}`)
      return
    }
    let srcPath = trimmed
    if (srcPath === '') {
      if (payload === '') {
        status('idle', 'transfer: import needs a bundle file')
        return
      }
      // Browser-picked bundle: stage the bytes, import, clean up.
      srcPath = path.join(os.tmpdir(), `dsh-memory-import-${Date.now()}.dshmem`)
      fs.writeFileSync(srcPath, Buffer.from(payload, 'base64'))
    }
    const staged = rawPath.trim() === ''
    try {
      const outcome = await importBundle(path.resolve(srcPath), db, paths)
      console.info(`[dsh-memory] imported ${outcome.imported} records (${outcome.duplicate} duplicates) from ${srcPath}`)
      status('idle',
        `transfer: imported ${outcome.imported} records, ${outcome.filesImported} files`
          + ` (${outcome.duplicate} duplicates skipped, ${outcome.targetWins} conflicts kept local)`)
    } finally {
      if (staged) fs.rmSync(srcPath, { force: true })
    }
  } catch (error) {
    console.warn(`[dsh-memory] transfer ${direction} failed:`, error)
    status('idle', `transfer: ${direction} failed: ${String(error).slice(0, 160)}`)
  }
}
