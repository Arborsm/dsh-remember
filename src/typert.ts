/**
 * Host-face Typert manifest for the `memory` remote service.
 *
 * The Typert loader discovers this file through `exports["./typert"]` of the
 * mounted bundle entry, validates it, and registers every invocation with the
 * gateway. Descriptors therefore have to match `rpc.ts` exactly: the gateway
 * rejects unknown wires, and missing optional arguments are only tolerated for
 * parameters that declare `acceptsUndefined`.
 *
 * Codecs are hand-written on purpose: the plugin is a standalone package, so
 * the workspace-bound Typert generator cannot emit them here. Both halves
 * repeat the same shapes (`src/client/remote.ts` mounts the client mirror).
 */

/** Minimal parser face every strict codec factory returns. */
export interface TypertSchema<T> {
  parse(value: unknown): T
}

/** Strict codec shape the Typert loader and gateway accept. */
export interface TypertStrictCodec<T> {
  mode: 'strict'
  typeSymbol: string
  create(): TypertSchema<T>
}

const codec = <T>(name: string, parse: (value: unknown) => T): TypertStrictCodec<T> => ({
  mode: 'strict',
  typeSymbol: `dsh-remember#${name}`,
  create: () => ({ parse }),
})

function requireObject(value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function optionalString(value: unknown, subject: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new TypeError(`${subject} must be a string`)
  return value
}

function requireString(value: unknown, subject: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${subject} must be a non-empty string`)
  }
  return value
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function stringRecord(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { ...requireObject(value, 'record') }
}

const statusCodec = codec('MemoryStatus', (value) => {
  const record = requireObject(value, 'memory status')
  return {
    phase: typeof record.phase === 'string' ? record.phase : 'idle',
    detail: typeof record.detail === 'string' ? record.detail : '',
    summaryPreview: typeof record.summaryPreview === 'string' ? record.summaryPreview : '',
    updatedAt: numberOr(record.updatedAt, 0),
  }
})

const configSnapshotCodec = codec('ConfigSnapshot', (value) => {
  const record = requireObject(value, 'config snapshot')
  return {
    value: stringRecord(record.value),
    base: stringRecord(record.base),
    user: stringRecord(record.user),
    revision: numberOr(record.revision, 0),
  }
})

const viewCodec = codec('MemoryView', (value) => {
  const record = requireObject(value, 'memory view')
  return {
    blobs: typeof record.blobs === 'string' ? record.blobs : '',
    records: typeof record.records === 'string' ? record.records : '[]',
    activity: typeof record.activity === 'string' ? record.activity : '[]',
    pipeline: typeof record.pipeline === 'string' ? record.pipeline : '{}',
    translatedStale: record.translatedStale === true,
    translating: record.translating === true,
    updatedAt: numberOr(record.updatedAt, 0),
  }
})

const configPatchCodec = codec('ConfigPatch', (value) => {
  const patch = requireObject(value, 'config patch')
  const entries = Object.entries(patch)
  for (const [key, entry] of entries) {
    // Only scalar/array/list values are reasonable to arrive over the wire;
    // the schema itself validates ranges after the merge.
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      throw new TypeError(`config field "${key}" must be a scalar, array, or null`)
    }
  }
  return { ...patch }
})

const commandRequestCodec = codec('CommandRequest', (value) => {
  const record = requireObject(value, 'command request')
  // Absent fields are omitted rather than set to undefined: the gateway runs a
  // JSON-safety pass over the parsed value, and an own `undefined` property
  // fails that boundary check even though JSON would just drop it.
  const request: {
    action: string
    path?: string
    arg?: string
    payload?: string
    force: boolean
  } = {
    action: requireString(record.action, 'command action'),
    force: record.force === true,
  }
  const path = optionalString(record.path, 'command path')
  if (path !== undefined) request.path = path
  const arg = optionalString(record.arg, 'command arg')
  if (arg !== undefined) request.arg = arg
  const payload = optionalString(record.payload, 'command payload')
  if (payload !== undefined) request.payload = payload
  return request
})

const commandResultCodec = codec('CommandResult', (value) => {
  const record = requireObject(value, 'command result')
  const result: Record<string, unknown> = {
    ok: record.ok === true,
    detail: typeof record.detail === 'string' ? record.detail : '',
  }
  if (record.bundle !== undefined) {
    const bundle = requireObject(record.bundle, 'command bundle')
    result.bundle = { name: requireString(bundle.name, 'bundle name'), data: requireString(bundle.data, 'bundle data') }
  }
  if (record.view !== undefined) result.view = viewCodec.create().parse(record.view)
  return result
})

/** Wires of the `memory` namespace, in service order. */
export const MEMORY_INVOCATIONS = [
  {
    id: 'dsh-remember#memory/getStatus',
    service: 'memory',
    namespace: 'memory',
    method: 'getStatus',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: statusCodec,
    description: 'Current scheduler phase, status detail, and summary preview.',
  },
  {
    id: 'dsh-remember#memory/getConfig',
    service: 'memory',
    namespace: 'memory',
    method: 'getConfig',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: configSnapshotCodec,
    description: 'Effective plugin config with the base/user layers and a revision.',
  },
  {
    id: 'dsh-remember#memory/updateConfig',
    service: 'memory',
    namespace: 'memory',
    method: 'updateConfig',
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'patch', wire: 'patch', source: 'json' as const, codec: configPatchCodec }],
    result: configSnapshotCodec,
    description: 'Validate and persist a config patch, returning the new snapshot.',
  },
  {
    id: 'dsh-remember#memory/unsetConfig',
    service: 'memory',
    namespace: 'memory',
    method: 'unsetConfig',
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'field', wire: 'field', source: 'json' as const, codec: codec('ConfigField', (value) => requireString(value, 'config field')) }],
    result: configSnapshotCodec,
    description: 'Reset one config field to the loader base value.',
  },
  {
    id: 'dsh-remember#memory/getView',
    service: 'memory',
    namespace: 'memory',
    method: 'getView',
    invocation: { kind: 'direct' as const },
    parameters: [],
    result: viewCodec,
    description: 'Memory artifact snapshot for the viewer page.',
  },
  {
    id: 'dsh-remember#memory/runCommand',
    service: 'memory',
    namespace: 'memory',
    method: 'runCommand',
    invocation: { kind: 'direct' as const },
    parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: commandRequestCodec }],
    result: commandResultCodec,
    description: 'Run one user action (cycle, scheduling, folder, transfer, translate).',
  },
]

const SERVICE_DOC = {
  description: 'Memory subsystem of dsh-remember: config, status, viewer data, and user actions.',
  summary: 'Reads and edits the memory plugin state from the browser.',
  tags: ['memory', 'settings'],
  key: 'memory',
  exportName: 'MemoryService',
  members: MEMORY_INVOCATIONS.map((invocation) => ({
    kind: 'method',
    name: invocation.method,
    signature: `${invocation.method}(${invocation.parameters.map((parameter) => `${parameter.name}: unknown`).join(', ')})`,
    summary: invocation.description,
  })),
  types: [],
}

/** The manifest the Typert loader registers for this package. */
export const TYPERT = {
  package: 'dsh-remember',
  face: 'host' as const,
  schemas: [],
  invocations: MEMORY_INVOCATIONS,
  model: { services: [SERVICE_DOC], events: [], objects: [] },
  events: [],
  objects: [],
}
