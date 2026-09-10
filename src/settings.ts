import { gzipSync } from 'node:zlib'

import Schema from '@deepseek-ai/schemastery'

import type { DshContext } from './dsh-types.ts'
import type { MemoryPluginConfig } from './config.ts'
import { Config } from './config.ts'

export const MEMORY_SETTINGS_NS = 'memory'
export const MEMORY_STATUS_NS = 'memory-status'

const MemoryStatusSchema = Schema.object({
  /** idle | phase1 | phase2 */
  phase: Schema.string().default('idle'),
  detail: Schema.string().default(''),
  /** Head of memory_summary.md after the last successful consolidation. */
  summaryPreview: Schema.string().default(''),
  updatedAt: Schema.number().default(0),
})

export interface MemoryStatus {
  phase: string
  detail: string
  summaryPreview: string
  updatedAt: number
}

export type StatusWriter = (phase: string, detail: string, summaryPreview?: string) => void

const MemoryCommandsSchema = Schema.object({
  /** run-cycle | toggle-schedule | open-folder | export | import | refresh-view | translate-memory */
  action: Schema.string().default(''),
  /** Bundle directory for export/import. */
  path: Schema.string().default(''),
  /** Extra argument (translate-memory: target language tag, e.g. zh). */
  arg: Schema.string().default(''),
  /** translate-memory: ignore the translation memory and rebuild everything. */
  force: Schema.boolean().default(false),
  requestedAt: Schema.number().default(0),
})

export const MEMORY_COMMANDS_NS = 'memory-commands'

/** Viewer payload namespace: the host mirrors workspace content for the web viewer. */
const MemoryViewSchema = Schema.object({
  /**
   * Base64 gzip of `{ summary, index, translatedSummary }`. The texts are
   * large (tens of KB); compressing them keeps the persisted settings mirror
   * small. The client decodes with DecompressionStream.
   */
  blobs: Schema.string().default(''),
  /** memory_summary.zh.md exists but predates the current summary. */
  translatedStale: Schema.boolean().default(false),
  /** True while a translation request is running. */
  translating: Schema.boolean().default(false),
  /** JSON array of stage-1 record stats for the records table. */
  records: Schema.string().default('[]'),
  updatedAt: Schema.number().default(0),
})

export const MEMORY_VIEW_NS = 'memory-view'

/** Raw texts the writer accepts; they are compressed into the published `blobs`. */
export interface MemoryViewInput {
  summary?: string
  index?: string
  translatedSummary?: string
  translatedIndex?: string
  translatedStale?: boolean
  translating?: boolean
  records?: string
}

interface MemoryViewSection {
  blobs: string
  translatedStale: boolean
  translating: boolean
  records: string
  updatedAt: number
}

export type ViewWriter = (view: MemoryViewInput) => void

/** Register the viewer namespace; returns a partial-merge writer (no-op without the settings provider). */
export function installMemoryView(ctx: DshContext): ViewWriter {
  const texts = { summary: '', index: '', translatedSummary: '', translatedIndex: '' }
  let current: MemoryViewSection = { blobs: encodeBlobs(texts), translatedStale: false, translating: false, records: '[]', updatedAt: 0 }
  let replace: ((section: MemoryViewSection) => Promise<void>) | null = null
  let published = false
  /** Last persisted payload ignoring updatedAt: unchanged content skips the write. */
  let lastPayload = ''
  ctx.inject(['settings'], (serviceCtx) => {
    const provider = (serviceCtx as DshContext).settings
    if (provider == null) return
    const scope = provider.register(MEMORY_VIEW_NS, MemoryViewSchema as never)
    replace = (section) => scope.replace(section)
    // The first publish usually happens before the settings service resolves;
    // flush the latched value so the viewer never starts empty.
    if (published) void replace(current).catch(() => {})
  })
  return (view) => {
    if (view.summary !== undefined) texts.summary = view.summary
    if (view.index !== undefined) texts.index = view.index
    if (view.translatedSummary !== undefined) texts.translatedSummary = view.translatedSummary
    if (view.translatedIndex !== undefined) texts.translatedIndex = view.translatedIndex
    current = {
      ...current,
      blobs: encodeBlobs(texts),
      translatedStale: view.translatedStale ?? current.translatedStale,
      translating: view.translating ?? current.translating,
      records: view.records ?? current.records,
      updatedAt: Date.now(),
    }
    published = true
    const write = replace
    if (write == null) return
    const payload = JSON.stringify({ ...current, updatedAt: 0 })
    if (payload === lastPayload) return
    lastPayload = payload
    void write(current).catch(() => {})
  }
}

function encodeBlobs(texts: { summary: string; index: string; translatedSummary: string; translatedIndex: string }): string {
  return gzipSync(Buffer.from(JSON.stringify(texts), 'utf8')).toString('base64')
}

/**
 * Register the plugin's settings namespace so the web Settings → Plugins page
 * can edit the live configuration, mirroring the bash-local pattern: the
 * composition entry is the base layer, the user layer persists in
 * settings.yaml, and every committed change is folded back into the SAME
 * config object the scheduler and read path already read (in-place assign
 * keeps every captured reference live).
 */
export function installMemorySettings(ctx: DshContext, config: MemoryPluginConfig): void {
  ctx.inject(['settings'], (serviceCtx) => {
    const provider = (serviceCtx as DshContext).settings
    if (provider == null) return
    let read: () => MemoryPluginConfig = () => config
    provider.installSection(ctx, MEMORY_SETTINGS_NS, Config as never, config, {
      setSource: (get) => {
        read = get as unknown as () => MemoryPluginConfig
        Object.assign(config, read())
      },
      onChange: () => {
        Object.assign(config, read())
        console.info('[dsh-memory] settings committed: enabled=%s generate=%s use=%s',
          String(config.enabled), String(config.generateMemories), String(config.useMemories))
      },
    })
  })
}

/**
 * Register the memory-status namespace: the host writes processing state
 * here on every phase transition and the browser float reads it through the
 * settings mirror (settings/document-updated is already forwarded to
 * clients — no custom RPC required).
 */
export function installMemoryStatus(
  ctx: DshContext,
): { write: StatusWriter; onCommand: (handler: (action: string, path: string, arg: string, force: boolean) => void) => void } {
  let replace: ((section: MemoryStatus) => Promise<void>) | null = null
  ctx.inject(['settings'], (serviceCtx) => {
    const provider = (serviceCtx as DshContext).settings
    if (provider == null) return
    const statusScope = provider.register(MEMORY_STATUS_NS, MemoryStatusSchema as never)
    replace = (section) => statusScope.replace(section)
    // A stale phase from a crashed previous run must not outlive this boot.
    void replace({ phase: 'idle', detail: '', summaryPreview: '', updatedAt: Date.now() }).catch(() => {})

    // Widget → host action channel: the float writes an action here and the
    // scheduler's watch executes it (same settings push path as the status).
    const commandsScope = provider.register(MEMORY_COMMANDS_NS, MemoryCommandsSchema as never)
    let lastHandledAt = 0
    commandsScope.watch((next) => {
      const command = next as { action?: string; path?: string; arg?: string; force?: boolean; requestedAt?: number }
      const action = command?.action ?? ''
      const requestedAt = command?.requestedAt ?? 0
      if (action === '' || requestedAt <= lastHandledAt) return
      lastHandledAt = requestedAt
      handler(action, command?.path ?? '', command?.arg ?? '', command?.force === true)
      void commandsScope.replace({ action: '', path: '', arg: '', force: false, requestedAt }).catch(() => {})
    })
  })
  const handler = (action: string, path: string, arg: string, force: boolean): void => {
    commandHandler?.(action, path, arg, force)
  }
  let commandHandler: ((action: string, path: string, arg: string, force: boolean) => void) | null = null
  return {
    write: (phase, detail, summaryPreview = '') => {
      const write = replace
      if (write == null) return
      void write({ phase, detail, summaryPreview, updatedAt: Date.now() }).catch(() => {})
    },
    onCommand: (onAction) => {
      commandHandler = onAction
    },
  }
}
