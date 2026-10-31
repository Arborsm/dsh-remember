/**
 * The `memory` remote service: the single Host entry point the browser half
 * calls through `remote.memory.*` (config read/write, status polling, viewer
 * snapshots, and every user action that used to travel as a settings-namespace
 * command). The Typert manifest in `./typert.ts` describes this object, so the
 * gateway dispatches strict descriptors instead of reverse-engineering it.
 */

import { exec } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import type { MemoryPluginConfig } from './config.ts'
import type { MemoryDatabase } from './db.ts'
import type { DshContext } from './dsh-types.ts'
import type { MemoryPaths } from './paths.ts'
import type { ConfigSnapshot, MemoryState, MemoryStatus, MemoryViewPayload, StatusWriter, ViewWriter } from './state.ts'
import { buildExportBundle, importBundle, writeExportBundle } from './transfer.ts'
import { publishMemoryView, translateMemory } from './view.ts'

/** One UI action, mirroring the fields the old memory-commands namespace had. */
export interface MemoryCommandRequest {
  action: string
  path?: string
  arg?: string
  payload?: string
  force?: boolean
}

/** Handoff for the browser's own save dialog. */
export interface MemoryBundleHandoff {
  name: string
  data: string
}

export interface MemoryCommandResult {
  ok: boolean
  detail: string
  bundle?: MemoryBundleHandoff
  view?: MemoryViewPayload
}

export interface MemoryServiceOptions {
  ctx: DshContext
  db: MemoryDatabase
  paths: MemoryPaths
  config: MemoryPluginConfig
  state: MemoryState
  /** Scheduler trigger, injected by the plugin so the service owns no timer. */
  requestCycle: () => void
}

/** The Host surface exposed as `remote.memory`. */
export interface MemoryService {
  getStatus(): MemoryStatus
  getConfig(): ConfigSnapshot
  updateConfig(patch: Record<string, unknown>): ConfigSnapshot
  unsetConfig(field: string): ConfigSnapshot
  getView(): MemoryViewPayload
  runCommand(request: MemoryCommandRequest): Promise<MemoryCommandResult>
}

/**
 * Build the service object and brand it for the gateway. The binding must
 * carry the same object identity (`service`) and the exact namespace the
 * descriptors use, otherwise every dispatch fails with `gateway/binding-invalid`.
 */
export function createMemoryService(options: MemoryServiceOptions): MemoryService {
  const { state } = options
  const service: MemoryService = {
    getStatus: () => state.statusSnapshot(),
    getConfig: () => state.snapshot(),
    updateConfig: (patch) => state.update(patch),
    unsetConfig: (field) => state.clear(field),
    getView: () => state.viewSnapshot(),
    runCommand: (request) => runCommand(options, request),
  }
  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: 'memory', namespace: 'memory' },
  })
  return service
}

async function runCommand(
  options: MemoryServiceOptions,
  request: MemoryCommandRequest,
): Promise<MemoryCommandResult> {
  const { ctx, db, paths, config, state } = options
  const action = typeof request?.action === 'string' ? request.action : ''
  const argPath = typeof request?.path === 'string' ? request.path : ''
  const arg = typeof request?.arg === 'string' ? request.arg : ''
  const payload = typeof request?.payload === 'string' ? request.payload : ''
  const status = state.writeStatus
  switch (action) {
    case 'run-cycle':
      options.requestCycle()
      return { ok: true, detail: 'scheduler: memory cycle requested' }
    case 'toggle-schedule': {
      const next = state.update({ generateMemories: config.generateMemories !== true })
      console.info(`[dsh-memory] scheduling ${next.value.generateMemories === true ? 'resumed' : 'paused'}`)
      return { ok: true, detail: `scheduler: ${next.value.generateMemories === true ? 'resumed' : 'paused'}` }
    }
    case 'open-folder':
      exec(`explorer "${paths.workspaceRoot}"`, () => {})
      return { ok: true, detail: `opened ${paths.workspaceRoot}` }
    case 'refresh-view':
      publishMemoryView(db, paths, state.writeView)
      return { ok: true, detail: 'view refreshed', view: state.viewSnapshot() }
    case 'export':
      return exportMemory(db, paths, argPath, status)
    case 'import':
      return importMemory(db, paths, argPath, payload, status)
    case 'translate-memory':
      void runTranslate(arg || 'zh', request?.force === true, ctx, db, paths, config, state.writeView, status)
      return { ok: true, detail: `translate: ${request?.force === true ? 'rebuilding' : 'starting'}…` }
    default:
      return { ok: false, detail: `unknown command: ${action || '(empty)'}` }
  }
}

/** Export: a requested path writes to disk, otherwise hand the browser the bytes. */
function exportMemory(
  db: MemoryDatabase,
  paths: MemoryPaths,
  rawPath: string,
  status: StatusWriter,
): MemoryCommandResult {
  const trimmed = rawPath.trim()
  try {
    const bundle = buildExportBundle(paths, db, 'dsh-web')
    if (trimmed === '') {
      const stamp = new Date().toISOString().slice(0, 19).replaceAll('-', '').replaceAll(':', '')
      const data = gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8')).toString('base64')
      status('idle', `transfer: exported ${bundle.records.length} records — choose where to save the bundle`)
      return {
        ok: true,
        detail: `transfer: exported ${bundle.records.length} records`,
        bundle: { name: `dsh-memory-${stamp}.dshmem`, data },
      }
    }
    const target = path.resolve(trimmed)
    if (target === paths.workspaceRoot || target.startsWith(paths.workspaceRoot + path.sep)) {
      const detail = 'transfer: export destination must be outside the memory workspace'
      status('idle', detail)
      return { ok: false, detail }
    }
    const manifest = writeExportBundle(bundle, target)
    console.info(`[dsh-memory] exported ${manifest.recordCount} records, ${manifest.fileCount} files -> ${target}`)
    const detail = `transfer: exported ${manifest.recordCount} records and ${manifest.fileCount} files to ${target}`
    status('idle', detail)
    return { ok: true, detail }
  } catch (error) {
    console.warn('[dsh-memory] export failed:', error)
    const detail = `transfer: export failed: ${String(error).slice(0, 160)}`
    status('idle', detail)
    return { ok: false, detail }
  }
}

/** Import: a browser-picked bundle arrives base64 and is staged to a temp file. */
async function importMemory(
  db: MemoryDatabase,
  paths: MemoryPaths,
  rawPath: string,
  payload: string,
  status: StatusWriter,
): Promise<MemoryCommandResult> {
  const trimmed = rawPath.trim()
  let srcPath = trimmed
  const staged = trimmed === ''
  try {
    if (staged) {
      if (payload === '') {
        const detail = 'transfer: import needs a bundle file'
        status('idle', detail)
        return { ok: false, detail }
      }
      srcPath = path.join(os.tmpdir(), `dsh-memory-import-${Date.now()}.dshmem`)
      fs.writeFileSync(srcPath, Buffer.from(payload, 'base64'))
    }
    const outcome = await importBundle(path.resolve(srcPath), db, paths)
    console.info(`[dsh-memory] imported ${outcome.imported} records (${outcome.duplicate} duplicates) from ${srcPath}`)
    const detail = `transfer: imported ${outcome.imported} records, ${outcome.filesImported} files`
      + ` (${outcome.duplicate} duplicates skipped, ${outcome.targetWins} conflicts kept local)`
    status('idle', detail)
    return { ok: true, detail }
  } catch (error) {
    console.warn('[dsh-memory] import failed:', error)
    const detail = `transfer: import failed: ${String(error).slice(0, 160)}`
    status('idle', detail)
    return { ok: false, detail }
  } finally {
    if (staged && srcPath !== '') fs.rmSync(srcPath, { force: true })
  }
}

/** Translate the memory artifacts; outcomes land in the status line. */
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
