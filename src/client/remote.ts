/**
 * Browser-side binding of the Host `memory` remote.
 *
 * DSH 0.2 dropped the client `settingsScope` service, so the two halves talk
 * through the Typert gateway instead: this module mounts the client half of
 * the manifest (`src/typert.ts` describes the host face) and exposes the
 * namespace as small snapshot stores the existing components already know how
 * to consume (`ScopeView` / selector hooks).
 */

import type {
  ClientContext,
  CommandRunner,
  MemoryCommandRequest,
  MemoryCommandResult,
  ScopeSnapshot,
  ScopeView,
} from './types.ts'

export interface MemoryStatusPayload {
  phase: string
  detail: string
  summaryPreview: string
  updatedAt: number
}

export interface MemoryConfigPayload {
  value: Record<string, unknown>
  base: Record<string, unknown>
  user: Record<string, unknown>
  revision: number
}

export interface MemoryViewPayload {
  blobs: string
  records: string
  translatedStale: boolean
  translating: boolean
  updatedAt: number
}

interface RemoteFailure {
  code?: string
  message?: string
}

type RemoteResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/** The namespace service the gateway installs as `remote.memory`. */
interface MemoryRemote {
  getStatus(): Promise<RemoteResult<MemoryStatusPayload>>
  getConfig(): Promise<RemoteResult<MemoryConfigPayload>>
  updateConfig(patch: Record<string, unknown>): Promise<RemoteResult<MemoryConfigPayload>>
  unsetConfig(field: string): Promise<RemoteResult<MemoryConfigPayload>>
  getView(): Promise<RemoteResult<MemoryViewPayload>>
  runCommand(request: MemoryCommandRequest): Promise<RemoteResult<MemoryCommandResult>>
}

/**
 * Result codecs exist only to satisfy the strict-codec contract; the gateway
 * already delivered parsed JSON, so the browser side does no re-parsing.
 */
const passthrough = (name: string) => ({
  mode: 'strict' as const,
  typeSymbol: `dsh-remember#${name}`,
  create: () => ({ parse: <T>(value: unknown): T => value as T }),
})

const jsonParameter = (name: string, typeName: string) => ({
  name,
  wire: name,
  source: 'json' as const,
  codec: passthrough(typeName),
})

const descriptor = (method: string, parameters: ReturnType<typeof jsonParameter>[], resultName: string) => ({
  id: `dsh-remember#memory/${method}`,
  service: 'memory',
  namespace: 'memory',
  method,
  invocation: { kind: 'direct' as const },
  parameters,
  result: passthrough(resultName),
})

/** Mirrors MEMORY_INVOCATIONS in src/typert.ts (method names and wires must match). */
const CONTRIBUTION = {
  package: 'dsh-remember',
  descriptors: [
    descriptor('getStatus', [], 'MemoryStatus'),
    descriptor('getConfig', [], 'ConfigSnapshot'),
    descriptor('updateConfig', [jsonParameter('patch', 'ConfigPatch')], 'ConfigSnapshot'),
    descriptor('unsetConfig', [jsonParameter('field', 'ConfigField')], 'ConfigSnapshot'),
    descriptor('getView', [], 'MemoryView'),
    descriptor('runCommand', [jsonParameter('request', 'CommandRequest')], 'CommandResult'),
  ],
}

const STATUS_POLL_MS = 2_500
const CONFIG_POLL_MS = 15_000
const VIEW_POLL_MS = 5_000

/** A snapshot store with change notification, in the Shape components expect. */
class BridgeStore<T> {
  private snapshot: ScopeSnapshot<T>
  private readonly listeners = new Set<() => void>()
  /** Fired when the subscriber count crosses zero; used for lazy polling. */
  onActiveChange: ((active: boolean) => void) | undefined

  constructor(initial: ScopeSnapshot<T>) {
    this.snapshot = initial
  }

  readonly getSnapshot = (): ScopeSnapshot<T> => this.snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (this.listeners.size === 1) this.onActiveChange?.(true)
    return () => {
      this.listeners.delete(listener)
      if (this.listeners.size === 0) this.onActiveChange?.(false)
    }
  }

  set(snapshot: ScopeSnapshot<T>): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

const loadingSnapshot = <T>(): ScopeSnapshot<T> => ({
  status: 'loading',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'host',
})

const unavailableSnapshot = <T>(): ScopeSnapshot<T> => ({
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'host',
})

function failureDetail(error: RemoteFailure | undefined): string {
  if (error == null) return 'memory host call failed'
  return `${error.code ?? 'error'}: ${error.message ?? 'unknown failure'}`
}

/**
 * Owns the mounted namespace plus the snapshot stores. Created synchronously
 * (slots need it immediately) and attached once `$mount` resolves.
 */
export class MemoryBridge {
  private remote: MemoryRemote | null = null
  private statusTimer: ReturnType<typeof setInterval> | undefined
  private configTimer: ReturnType<typeof setInterval> | undefined
  private viewTimer: ReturnType<typeof setInterval> | undefined

  private readonly configStore = new BridgeStore<Record<string, unknown>>(loadingSnapshot())
  private readonly statusStore = new BridgeStore<MemoryStatusPayload>(loadingSnapshot())
  private readonly viewStore = new BridgeStore<MemoryViewPayload>(loadingSnapshot())

  /** Settings page scope: `set`/`unset` persist config overrides on the host. */
  readonly configScope: ScopeView = {
    getSnapshot: () => this.configStore.getSnapshot(),
    subscribe: (listener) => this.configStore.subscribe(listener),
    set: async (field, value) => {
      await this.updateConfig({ [field]: value })
    },
    unset: async (field) => {
      await this.unsetConfig(field)
    },
  }

  /** Selector-hook source for the sidebar pill and the status banner. */
  readonly statusSource: { getSnapshot: () => ScopeSnapshot<MemoryStatusPayload>; subscribe: (l: () => void) => () => void } = {
    getSnapshot: () => this.statusStore.getSnapshot(),
    subscribe: (listener) => this.statusStore.subscribe(listener),
  }

  /** Selector-hook source for the viewer page (polls only while mounted). */
  readonly viewSource: { getSnapshot: () => ScopeSnapshot<MemoryViewPayload>; subscribe: (l: () => void) => () => void } = {
    getSnapshot: () => this.viewStore.getSnapshot(),
    subscribe: (listener) => this.viewStore.subscribe(listener),
  }

  /** The single action runner every widget uses. */
  readonly commands: CommandRunner = {
    run: (request) => this.runCommand(request),
  }

  constructor() {
    this.viewStore.onActiveChange = (active) => {
      if (active) {
        void this.refreshView()
        this.viewTimer = setInterval(() => { void this.refreshView() }, VIEW_POLL_MS)
      } else {
        this.stopTimer(this.viewTimer)
        this.viewTimer = undefined
      }
    }
  }

  attach(remote: MemoryRemote): void {
    this.remote = remote
    void this.refreshStatus()
    void this.refreshConfig()
    this.statusTimer = setInterval(() => { void this.refreshStatus() }, STATUS_POLL_MS)
    this.configTimer = setInterval(() => { void this.refreshConfig() }, CONFIG_POLL_MS)
  }

  detach(): void {
    this.stopTimer(this.statusTimer)
    this.stopTimer(this.configTimer)
    this.stopTimer(this.viewTimer)
    this.statusTimer = undefined
    this.configTimer = undefined
    this.viewTimer = undefined
    this.remote = null
  }

  async updateConfig(patch: Record<string, unknown>): Promise<void> {
    const remote = this.requireRemote()
    const result = await remote.updateConfig(patch)
    if (!result.ok) throw new Error(failureDetail(result.error))
    this.applyConfig(result.value)
    void this.refreshStatus()
  }

  async unsetConfig(field: string): Promise<void> {
    const remote = this.requireRemote()
    const result = await remote.unsetConfig(field)
    if (!result.ok) throw new Error(failureDetail(result.error))
    this.applyConfig(result.value)
  }

  async runCommand(request: MemoryCommandRequest): Promise<MemoryCommandResult> {
    const remote = this.remote
    if (remote == null) return { ok: false, detail: 'memory host unavailable' }
    let result: RemoteResult<MemoryCommandResult>
    try {
      result = await remote.runCommand(request)
    } catch (error) {
      return { ok: false, detail: String(error) }
    }
    if (!result.ok) return { ok: false, detail: failureDetail(result.error) }
    if (result.value.view !== undefined) this.applyView(result.value.view)
    else void this.refreshView()
    void this.refreshStatus()
    void this.refreshConfig()
    return result.value
  }

  async refreshView(): Promise<void> {
    const remote = this.remote
    if (remote == null) return
    try {
      const result = await remote.getView()
      if (!result.ok) throw new Error(failureDetail(result.error))
      this.applyView(result.value)
    } catch {
      this.viewStore.set(unavailableSnapshot())
    }
  }

  private applyView(view: MemoryViewPayload): void {
    this.viewStore.set({
      status: 'ready',
      value: view,
      base: undefined,
      user: undefined,
      revision: view.updatedAt,
      writable: false,
      mode: 'host',
    })
  }

  private applyConfig(config: MemoryConfigPayload): void {
    this.configStore.set({
      status: 'ready',
      value: config.value,
      base: config.base,
      user: config.user,
      revision: config.revision,
      writable: true,
      mode: 'host',
    })
  }

  private async refreshConfig(): Promise<void> {
    const remote = this.remote
    if (remote == null) return
    try {
      const result = await remote.getConfig()
      if (!result.ok) throw new Error(failureDetail(result.error))
      this.applyConfig(result.value)
    } catch {
      this.configStore.set(unavailableSnapshot())
    }
  }

  private async refreshStatus(): Promise<void> {
    const remote = this.remote
    if (remote == null) return
    try {
      const result = await remote.getStatus()
      if (!result.ok) throw new Error(failureDetail(result.error))
      const status = result.value
      this.statusStore.set({
        status: 'ready',
        value: status,
        base: undefined,
        user: undefined,
        revision: status.updatedAt,
        writable: false,
        mode: 'host',
      })
    } catch {
      this.statusStore.set(unavailableSnapshot())
    }
  }

  private requireRemote(): MemoryRemote {
    if (this.remote == null) throw new Error('memory host unavailable')
    return this.remote
  }

  private stopTimer(timer: ReturnType<typeof setInterval> | undefined): void {
    if (timer !== undefined) clearInterval(timer)
  }
}

/**
 * Mount the contribution and hand the resulting namespace to the bridge.
 * Returns the disposer the caller runs from its effect cleanup.
 */
export async function mountMemoryBridge(bridge: MemoryBridge, ctx: ClientContext): Promise<() => Promise<void>> {
  const remote = ctx.remote
  if (remote == null || typeof remote.$mount !== 'function') {
    throw new Error('the remote service is not available in this composition')
  }
  let dispose: () => Promise<void>
  try {
    dispose = await remote.$mount(CONTRIBUTION)
  } catch (error) {
    throw new Error(`mounting the memory remote contribution failed: ${String(error)}`)
  }
  const namespace = ctx.get('remote.memory') as MemoryRemote | undefined
  if (namespace == null) {
    await dispose()
    throw new Error('remote.memory is missing after mounting the contribution')
  }
  bridge.attach(namespace)
  return async () => {
    bridge.detach()
    await dispose()
  }
}
