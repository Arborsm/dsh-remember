/**
 * Structural faces of the browser-side dsh services this plugin consumes.
 * Services arrive through cordis injection — no dsh package is imported at
 * runtime, keeping the client bundle free of cross-plugin value imports.
 */

/** Snapshot of one client mirror store backed by the `memory` remote. */
export interface ScopeSnapshot<T = Record<string, unknown>> {
  status: 'loading' | 'ready' | 'unavailable'
  value: T | undefined
  base: unknown
  user: unknown
  revision: number | undefined
  writable: boolean
  mode: 'host' | 'memory'
}

/** One bound namespace scope (superseded by remote-backed stores). */
export interface ScopeView {
  getSnapshot(): ScopeSnapshot
  subscribe(listener: () => void): () => void
  set(field: string, value: unknown): Promise<void>
  unset(field: string): Promise<void>
}

/** One user action sent to the Host `memory` service. */
export interface MemoryCommandRequest {
  action: string
  path?: string
  arg?: string
  payload?: string
  force?: boolean
}

/** Handoff for a bundle the browser should save itself. */
export interface MemoryBundleHandoff {
  name: string
  data: string
}

export interface MemoryCommandResult {
  ok: boolean
  detail: string
  bundle?: MemoryBundleHandoff
  /** Fresh viewer payload when the command changed what the viewer reads. */
  view?: {
    blobs: string
    records: string
    translatedStale: boolean
    translating: boolean
    updatedAt: number
  }
}

/** Client-callable action runner (remote.memory.runCommand). */
export interface CommandRunner {
  run(request: MemoryCommandRequest): Promise<MemoryCommandResult>
}

/** One model route offered by the Host catalog (remote.session.modelCatalog). */
export interface CatalogModel {
  provider: string
  providerName: string
  model: string
  modelName: string
}

export interface SlotsApi {
  register(options: Record<string, unknown>, component: unknown): () => void
  inject(slot: string, factory: () => unknown): void
  entries(slot: string): unknown[]
  getVersion(slot: string): number
  subscribe(slot: string, listener: () => void): () => void
}

export interface LocaleApi {
  register(ns: string, dictionaries: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string) => string
}

export interface ClientContext {
  slots: SlotsApi
  locale: LocaleApi
  /** Typert gateway client: mounts a contribution, then `get('remote.<ns>')`. */
  remote?: {
    $mount(contribution: unknown): Promise<() => Promise<void>>
  }
  /** Service lookup (remote namespaces appear here after a mount). */
  get(name: string): unknown
  /** Right-sidebar tab type registry (ui-sidebar-right; optional in the composition). */
  sidebarRightTabs?: { register(definition: Record<string, unknown>): () => void }
  /** Right-sidebar controller (ui-sidebar-right); opens viewer tabs programmatically. */
  sidebarRight?: { openTab(kind: string, options?: Record<string, unknown>): void }
  on(event: string, handler: (...args: never[]) => unknown): () => void
  effect(setup: () => void | (() => void), name?: string): void
  /** Lazy optional-service access: the callback runs once every named service is present. */
  inject(names: string[], callback: (ctx: ClientContext) => void): void
}
