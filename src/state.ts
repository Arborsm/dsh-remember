/**
 * Host-side runtime state of one memory plugin entry: the effective config
 * (loader Config as the base layer plus user overrides), the status line the
 * sidebar pill renders, and the viewer snapshot.
 *
 * Config edits made in the web UI are persisted next to the memory workspace
 * (`~/.dsh-memory/config.json`) instead of the deployment's settings document:
 * DSH 0.2 settings forms only serve `.volatile()` Config fields of uniquely
 * addressed profile entries, so a plugin-owned file keeps the base config
 * authoritative while still surviving a restart.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

import { Config, type MemoryPluginConfig } from './config.ts'

/** Processing state of the scheduler (rendered by the sidebar pill). */
export interface MemoryStatus {
  phase: string
  detail: string
  summaryPreview: string
  updatedAt: number
}

export type StatusWriter = (phase: string, detail: string, summaryPreview?: string) => void

/** Text/records the viewer reads; texts travel gzip+base64 in `blobs`. */
export interface MemoryViewInput {
  summary?: string
  index?: string
  translatedSummary?: string
  translatedIndex?: string
  translatedStale?: boolean
  translating?: boolean
  records?: string
  activity?: string
  pipeline?: string
}

export type ViewWriter = (view: MemoryViewInput) => void

export interface MemoryViewPayload {
  blobs: string
  records: string
  activity: string
  pipeline: string
  translatedStale: boolean
  translating: boolean
  updatedAt: number
}

/** Effective config + provenance, as the settings page needs it. */
export interface ConfigSnapshot {
  value: Record<string, unknown>
  base: Record<string, unknown>
  user: Record<string, unknown>
  revision: number
}

interface OverridesFile {
  user?: Record<string, unknown>
  revision?: number
}

const OVERRIDES_FILE = 'config.json'

/** Absolute path of the persisted config overrides. */
export function overridesPath(): string {
  return path.join(os.homedir(), '.dsh-memory', OVERRIDES_FILE)
}

function readOverrides(): { user: Record<string, unknown>; revision: number } {
  try {
    const parsed = JSON.parse(fs.readFileSync(overridesPath(), 'utf8')) as OverridesFile
    const user = typeof parsed?.user === 'object' && parsed.user !== null ? parsed.user : {}
    const revision = typeof parsed?.revision === 'number' ? parsed.revision : 1
    return { user, revision }
  } catch {
    return { user: {}, revision: 1 }
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => sameValue(item, right[index]))
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const keys = Object.keys(left)
    return keys.length === Object.keys(right).length
      && keys.every((key) => sameValue(left[key], right[key]))
  }
  return false
}

function encodeBlobs(texts: Record<string, string>): string {
  return gzipSync(Buffer.from(JSON.stringify(texts), 'utf8')).toString('base64')
}

/** One plugin entry's live state. The config object is mutated in place so
 * every component that closed over it (scheduler, read path) sees the edit. */
export class MemoryState {
  private readonly base: Record<string, unknown>
  private user: Record<string, unknown> = {}
  private revision = 1
  private readonly status: MemoryStatus = {
    phase: 'idle',
    detail: '',
    summaryPreview: '',
    updatedAt: 0,
  }
  private readonly view: MemoryViewPayload = {
    blobs: '',
    records: '[]',
    activity: '[]',
    pipeline: '{}',
    translatedStale: false,
    translating: false,
    updatedAt: 0,
  }
  private texts: Record<string, string> = {
    summary: '',
    index: '',
    translatedSummary: '',
    translatedIndex: '',
  }

  constructor(private readonly config: MemoryPluginConfig) {
    this.base = Config(config) as unknown as Record<string, unknown>
    const loaded = readOverrides()
    const merged = this.validate({ ...this.base, ...loaded.user })
    Object.assign(this.config, merged)
    this.user = this.overridesOf(merged)
    this.revision = loaded.revision
  }

  /** Effective config + base/user layers for the settings page. */
  snapshot(): ConfigSnapshot {
    return {
      value: { ...(this.config as unknown as Record<string, unknown>) },
      base: { ...this.base },
      user: { ...this.user },
      revision: this.revision,
    }
  }

  /** Apply an edit, persist the resulting override set, and bump the revision. */
  update(patch: Record<string, unknown>): ConfigSnapshot {
    const next = this.parse({ ...(this.config as unknown as Record<string, unknown>), ...patch })
    this.apply(next)
    return this.snapshot()
  }

  /** Drop one override, returning the field to the loader base value. */
  clear(field: string): ConfigSnapshot {
    if (!Object.hasOwn(this.base, field)) {
      throw new Error(`unknown config field: ${field}`)
    }
    const next = { ...(this.config as unknown as Record<string, unknown>) }
    next[field] = this.base[field]
    this.apply(this.parse(next))
    return this.snapshot()
  }

  /** Status line writer handed to the scheduler and command handlers. */
  readonly writeStatus: StatusWriter = (phase, detail, summaryPreview) => {
    this.status.phase = phase
    this.status.detail = detail
    if (summaryPreview !== undefined) this.status.summaryPreview = summaryPreview
    this.status.updatedAt = Date.now()
  }

  statusSnapshot(): MemoryStatus {
    return { ...this.status }
  }

  /** Viewer writer: texts are recompressed only when one of them changed. */
  readonly writeView: ViewWriter = (input) => {
    let textsChanged = false
    for (const key of ['summary', 'index', 'translatedSummary', 'translatedIndex'] as const) {
      const value = input[key]
      if (value !== undefined && value !== this.texts[key]) {
        this.texts[key] = value
        textsChanged = true
      }
    }
    if (textsChanged) this.view.blobs = encodeBlobs(this.texts)
    if (input.records !== undefined) this.view.records = input.records
    if (input.activity !== undefined) this.view.activity = input.activity
    if (input.pipeline !== undefined) this.view.pipeline = input.pipeline
    if (input.translatedStale !== undefined) this.view.translatedStale = input.translatedStale
    if (input.translating !== undefined) this.view.translating = input.translating
    this.view.updatedAt = Date.now()
  }

  viewSnapshot(): MemoryViewPayload {
    return { ...this.view }
  }

  /** Constructor merge: a corrupt overrides file must not block plugin load. */
  private validate(input: Record<string, unknown>): Record<string, unknown> {
    try {
      return this.parse(input)
    } catch (error) {
      console.warn('[dsh-memory] config override rejected, keeping current values:', error)
      return { ...(this.config as unknown as Record<string, unknown>) }
    }
  }

  /** Edits from the UI are strict: an invalid value has to surface as failed. */
  private parse(input: Record<string, unknown>): Record<string, unknown> {
    return Config(input) as unknown as Record<string, unknown>
  }

  private overridesOf(merged: Record<string, unknown>): Record<string, unknown> {
    const user: Record<string, unknown> = {}
    for (const key of Object.keys(this.base)) {
      if (!sameValue(merged[key], this.base[key])) user[key] = merged[key]
    }
    return user
  }

  private apply(merged: Record<string, unknown>): void {
    Object.assign(this.config, merged)
    this.user = this.overridesOf(merged)
    this.revision += 1
    this.save()
  }

  private save(): void {
    const file = overridesPath()
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const body = `${JSON.stringify({ user: this.user, revision: this.revision }, null, 2)}\n`
      fs.writeFileSync(file, body, 'utf8')
    } catch (error) {
      console.warn('[dsh-memory] failed to persist config overrides:', error)
    }
  }
}
