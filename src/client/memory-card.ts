/**
 * The memory settings page: a staged-edit form over the `memory` settings
 * namespace, rendered as its own Settings section. Draft text is what a save
 * would store, and each field shows whether the user layer carries it.
 * Rendered with plain createElement — no JSX transform in this bundle.
 */

import { createElement, useState } from 'react'

import { SnapshotStore } from './store.ts'
import type { CatalogModel, ScopeView } from './types.ts'

let pageStyleInjected = false

/** Interactive styles (inline styles cannot express :hover/:focus). */
function ensurePageStyles(): void {
  if (pageStyleInjected || typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-memory-page]') != null) {
    pageStyleInjected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.dshMemoryPage = 'true'
  tag.textContent = [
    '@keyframes dsh-memory-pulse { 0% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.08); } 100% { opacity: 0.35; transform: scale(0.8); } }',
    '.dshm-btn { transition: border-color 150ms ease, background 150ms ease, color 150ms ease, opacity 150ms ease, transform 100ms ease; }',
    '.dshm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4b7bec); opacity: 1; background: rgba(75, 123, 236, 0.10); }',
    '.dshm-btn:active:not(:disabled) { transform: translateY(1px); }',
    '.dshm-btn:focus-visible { outline: 2px solid rgba(75, 123, 236, 0.5); outline-offset: 1px; }',
    '.dshm-input { transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease; outline: none; }',
    '.dshm-input:hover:not(:disabled) { border-color: rgba(128, 128, 128, 0.45); }',
    '.dshm-input:focus { border-color: var(--dsw-alias-brand-primary, #4b7bec); box-shadow: 0 0 0 3px rgba(75, 123, 236, 0.18); background: var(--dsw-alias-bg-base, transparent); }',
    '.dshm-row + .dshm-row { border-top: 1px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.12)); }',
    // Switch: DSH's Switch primitive spec (36x20 track, 16px thumb), keyed off
    // aria-checked so the paint cannot disagree with assistive state.
    '.dshm-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; corner-shape: round; background: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.45)); cursor: pointer; }',
    '.dshm-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #4b7bec); }',
    '.dshm-switch:disabled { cursor: default; opacity: 0.5; }',
    '.dshm-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4b7bec); outline-offset: 2px; }',
    '.dshm-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }',
    '.dshm-switch[aria-checked="true"] .dshm-thumb { transform: translateX(16px); }',
    '.dshm-advanced-head { transition: background 120ms ease; border-radius: 8px; }',
    '.dshm-advanced-head:hover { background: rgba(128, 128, 128, 0.07); }',
  ].join('\n')
  document.head.appendChild(tag)
  pageStyleInjected = true
}

export type FieldKind = 'string' | 'number' | 'boolean' | 'list' | 'model'

export interface FieldSpec {
  field: string
  kind: FieldKind
  group: string
}

/**
 * Every MemoryPluginConfig field, grouped for display. `advanced` collects the
 * knobs a routine user never touches (paths, backoff/retry tuning, the
 * consolidator denylist) behind a collapsed section.
 */
export const FIELD_SPECS: readonly FieldSpec[] = [
  { field: 'enabled', kind: 'boolean', group: 'general' },
  { field: 'generateMemories', kind: 'boolean', group: 'general' },
  { field: 'useMemories', kind: 'boolean', group: 'general' },
  { field: 'extractModel', kind: 'model', group: 'models' },
  { field: 'consolidationModel', kind: 'model', group: 'models' },
  { field: 'scanIntervalMinutes', kind: 'number', group: 'schedule' },
  { field: 'minRolloutIdleHours', kind: 'number', group: 'schedule' },
  { field: 'maxSessionAgeDays', kind: 'number', group: 'schedule' },
  { field: 'maxUnusedDays', kind: 'number', group: 'schedule' },
  { field: 'summaryTokenLimit', kind: 'number', group: 'recall' },
  { field: 'redactSecrets', kind: 'boolean', group: 'recall' },
  { field: 'workspaceDir', kind: 'string', group: 'advanced' },
  { field: 'dbPath', kind: 'string', group: 'advanced' },
  { field: 'phase2TimeoutMinutes', kind: 'number', group: 'advanced' },
  { field: 'phase2SuccessCooldownSeconds', kind: 'number', group: 'advanced' },
  { field: 'phase1RetryBackoffMinutes', kind: 'number', group: 'advanced' },
  { field: 'phase1MaxRetries', kind: 'number', group: 'advanced' },
  { field: 'phase1MaxPerCycle', kind: 'number', group: 'advanced' },
  { field: 'phase1MaxConcurrency', kind: 'number', group: 'advanced' },
  { field: 'extractInputContextRatio', kind: 'number', group: 'advanced' },
  { field: 'maxRolloutSummaries', kind: 'number', group: 'advanced' },
  { field: 'consolidatorDenyPatterns', kind: 'list', group: 'advanced' },
]

const FIELD_ORDER = new Map(FIELD_SPECS.map((spec, index) => [spec.field, index]))

interface FieldState {
  spec: FieldSpec
  text: string
  overridden: boolean
  invalid: boolean
}

export interface CardState {
  available: boolean
  writable: boolean
  dirty: boolean
  invalid: boolean
  saving: boolean
  failed: boolean
  catalogStatus: 'unavailable' | 'loading' | 'ready' | 'error'
  catalogModels: CatalogModel[]
  fields: FieldState[]
}

interface StagedEdit {
  text: string
  clear: boolean
}

/** Debounce between the last edit and its automatic commit. */
const AUTOSAVE_DELAY_MS = 500

function formatValue(spec: FieldSpec, value: unknown): string {
  if (value === undefined || value === null) return ''
  if (spec.kind === 'boolean') return value === true ? 'true' : 'false'
  if (spec.kind === 'list') return Array.isArray(value) ? value.join(', ') : ''
  return String(value)
}

function parseValue(spec: FieldSpec, text: string): { ok: boolean; value?: unknown } {
  const trimmed = text.trim()
  if (spec.kind === 'boolean') {
    if (trimmed === 'true') return { ok: true, value: true }
    if (trimmed === 'false') return { ok: true, value: false }
    return { ok: false }
  }
  if (trimmed === '') return { ok: true, value: undefined } // clear
  if (spec.kind === 'number') {
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? { ok: true, value: parsed } : { ok: false }
  }
  if (spec.kind === 'list') {
    const items = trimmed.split(',').map((item) => item.trim()).filter((item) => item !== '')
    return items.length > 0 ? { ok: true, value: items } : { ok: true, value: undefined }
  }
  return { ok: true, value: trimmed }
}

export class MemoryCardController {
  private readonly staged = new Map<string, StagedEdit>()
  private readonly store: SnapshotStore<CardState>
  private saving = false
  private failed = false
  private autosaveTimer: ReturnType<typeof setTimeout> | null = null
  private catalogStatus: 'unavailable' | 'loading' | 'ready' | 'error'
  private catalogModels: CatalogModel[] = []

  constructor(
    private readonly scope: ScopeView,
    private readonly loadCatalog: (() => Promise<CatalogModel[]>) | null,
  ) {
    this.catalogStatus = loadCatalog == null ? 'unavailable' : 'loading'
    this.store = new SnapshotStore(this.project())
    scope.subscribe(() => {
      this.store.set(this.project())
    })
    if (loadCatalog != null) void this.refreshCatalog()
  }

  /** Re-query the Host model catalog (exposed as a page action). */
  async refreshCatalog(): Promise<void> {
    if (this.loadCatalog == null) return
    this.catalogStatus = 'loading'
    this.publish()
    try {
      this.catalogModels = await this.loadCatalog()
      this.catalogStatus = 'ready'
    } catch {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  /** The observable page snapshot source for the section's hooks seat. */
  pageStore(): SnapshotStore<CardState> {
    return this.store
  }

  inject(): Record<string, unknown> {
    return {
      hooks: { memoryPage: this.store },
      edit: (field: string, text: string) => {
        this.staged.set(field, { text, clear: false })
        this.failed = false
        this.publish()
        this.scheduleAutosave()
      },
      resetField: (field: string) => {
        const spec = this.specOf(field)
        const base = (this.scope.getSnapshot().base as Record<string, unknown> | undefined)?.[field]
        this.staged.set(field, { text: formatValue(spec, base), clear: true })
        this.failed = false
        this.publish()
        this.scheduleAutosave()
      },
      refreshCatalog: () => {
        void this.refreshCatalog()
      },
    }
  }

  /** Auto-commit pending edits once typing pauses (checkbox/select/reset included). */
  private scheduleAutosave(): void {
    if (this.autosaveTimer != null) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = setTimeout(() => {
      this.autosaveTimer = null
      void this.save()
    }, AUTOSAVE_DELAY_MS)
  }

  private specOf(field: string): FieldSpec {
    const spec = FIELD_SPECS.find((candidate) => candidate.field === field)
    if (spec == null) throw new Error(`memory page has no field ${field}`)
    return spec
  }

  private project(): CardState {
    const snapshot = this.scope.getSnapshot()
    const section = (snapshot.value ?? {}) as Record<string, unknown>
    const user = snapshot.user as Record<string, unknown> | undefined
    const fields: FieldState[] = [...FIELD_SPECS]
      .sort((a, b) => (FIELD_ORDER.get(a.field) ?? 0) - (FIELD_ORDER.get(b.field) ?? 0))
      .map((spec) => {
        const staged = this.staged.get(spec.field)
        if (staged === undefined) {
          return {
            spec,
            text: formatValue(spec, section[spec.field]),
            overridden: user !== undefined && Object.hasOwn(user, spec.field),
            invalid: false,
          }
        }
        const parsed = parseValue(spec, staged.text)
        return {
          spec,
          text: staged.text,
          overridden: staged.clear ? false : parsed.ok && parsed.value !== undefined,
          invalid: !staged.clear && !parsed.ok,
        }
      })
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.plan(fields).length > 0,
      invalid: fields.some((field) => field.invalid),
      saving: this.saving,
      failed: this.failed,
      catalogStatus: this.catalogStatus,
      catalogModels: this.catalogModels,
      fields,
    }
  }

  /** Staged edits a save would perform, in field order. */
  private plan(fields: FieldState[]): Array<{ field: string; clear: boolean; value?: unknown }> {
    const section = (this.scope.getSnapshot().value ?? {}) as Record<string, unknown>
    const plan: Array<{ field: string; clear: boolean; value?: unknown }> = []
    for (const field of fields) {
      const staged = this.staged.get(field.spec.field)
      if (staged === undefined) continue
      if (staged.clear) {
        if (field.overridden) plan.push({ field: field.spec.field, clear: true })
        continue
      }
      const parsed = parseValue(field.spec, staged.text)
      if (!parsed.ok) continue
      if (formatValue(field.spec, section[field.spec.field]) === staged.text.trim()) continue
      if (parsed.value === undefined) {
        plan.push({ field: field.spec.field, clear: true })
      } else {
        plan.push({ field: field.spec.field, clear: false, value: parsed.value })
      }
    }
    return plan
  }

  private async save(): Promise<void> {
    const fields = this.project().fields
    const plan = this.plan(fields)
    if (plan.length === 0 || plan.some((item) => !item.clear && item.value === undefined)) return
    if (this.saving) {
      // A write is crossing the wire; retry the just-staged edit after it lands.
      this.scheduleAutosave()
      return
    }
    this.saving = true
    this.failed = false
    this.publish()
    let landed = true
    for (const item of plan) {
      try {
        if (item.clear) await this.scope.unset(item.field)
        else await this.scope.set(item.field, item.value)
      } catch {
        landed = false
      }
    }
    // Drop only the committed keys: edits staged while the write was in
    // flight keep their own pending autosave.
    if (landed) for (const item of plan) this.staged.delete(item.field)
    this.saving = false
    this.failed = !landed
    this.publish()
  }

  private publish(): void {
    this.store.set(this.project())
  }
}

// ── styling ─────────────────────────────────────────────────────────────────

const ACCENT = 'var(--dsw-alias-brand-primary, #4b7bec)'
const BORDER = 'var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.2))'
const DANGER = '#e05561'
const MUTED = 'var(--dsw-alias-label-secondary, rgba(128, 128, 128, 0.9))'

function sectionStyle(): Record<string, unknown> {
  return { marginTop: 26 }
}

function sectionHeaderStyle(): Record<string, unknown> {
  return {
    fontSize: 11,
    fontWeight: 650,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
    opacity: 0.5,
    margin: '0 2px 2px',
  }
}

function rowStyle(): Record<string, unknown> {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 20,
    minHeight: 34,
    padding: '9px 2px',
  }
}

function labelStackStyle(): Record<string, unknown> {
  return { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
}

function inputStyle(invalid: boolean): Record<string, unknown> {
  return {
    width: 230,
    boxSizing: 'border-box',
    padding: '6px 10px',
    fontSize: 12.5,
    borderRadius: 8,
    border: `1px solid ${invalid ? DANGER : BORDER}`,
    background: 'var(--dsw-alias-fill-tertiary, rgba(128, 128, 128, 0.06))',
    color: 'inherit',
    textAlign: 'left',
  }
}

function ghostButtonStyle(disabled: boolean): Record<string, unknown> {
  return {
    fontSize: 12,
    padding: '4px 12px',
    borderRadius: 8,
    cursor: disabled ? 'default' : 'pointer',
    border: `1px solid ${BORDER}`,
    background: 'transparent',
    color: 'inherit',
    opacity: disabled ? 0.4 : 0.8,
  }
}

function primaryButtonStyle(disabled: boolean): Record<string, unknown> {
  // Shell button tokens: a filled primary, not a washed-out translucent tint.
  return {
    fontSize: 12,
    padding: '4px 14px',
    borderRadius: 8,
    cursor: disabled ? 'default' : 'pointer',
    border: '1px solid transparent',
    background: disabled ? 'transparent' : 'var(--dsw-alias-button-info-fill, #4d6bfe)',
    color: disabled ? 'inherit' : 'var(--dsw-alias-label-primary-inverted, #fff)',
    fontWeight: 600,
    opacity: disabled ? 0.4 : 1,
  }
}

function badgeStyle(): Record<string, unknown> {
  return {
    fontSize: 10,
    padding: '1px 7px',
    borderRadius: 999,
    background: 'var(--dsw-alias-state-business-tertiary, rgba(75, 123, 236, 0.14))',
    color: ACCENT,
    whiteSpace: 'nowrap',
  }
}

// ── components ──────────────────────────────────────────────────────────────

/** Toggle switch for boolean fields (replaces the bare checkbox). */
function Switch(props: { on: boolean; disabled: boolean; label?: string; onToggle: (next: boolean) => void }) {
  return createElement('button', {
    type: 'button',
    role: 'switch',
    'aria-checked': props.on,
    'aria-label': props.label,
    disabled: props.disabled,
    className: 'dshm-switch',
    onClick: () => props.onToggle(!props.on),
  }, createElement('span', { className: 'dshm-thumb' }))
}

function FieldRow(props: {
  t: (key: string) => string
  state: FieldState
  disabled: boolean
  catalogModels?: CatalogModel[]
  onEdit: (text: string) => void
  onReset: () => void
}) {
  const { t, state, disabled } = props
  const hint = hintText(t, state.spec.field)
  let control
  if (state.spec.kind === 'boolean') {
    control = createElement(Switch, {
      on: state.text === 'true',
      disabled,
      label: t(`field_${state.spec.field}`),
      onToggle: (next: boolean) => props.onEdit(next ? 'true' : 'false'),
    })
  } else if (state.spec.kind === 'model') {
    control = createElement(ModelSelect, {
      t,
      state,
      catalogModels: props.catalogModels ?? [],
      disabled,
      onEdit: props.onEdit,
    })
  } else {
    control = createElement('input', {
      type: 'text',
      value: state.text,
      disabled,
      spellCheck: false,
      className: 'dshm-input',
      onChange: (event: { target: { value: string } }) => {
        props.onEdit(event.target.value)
      },
      style: inputStyle(state.invalid),
    })
  }
  return createElement('div', { key: state.spec.field, className: 'dshm-row', style: rowStyle() },
    createElement('div', { style: labelStackStyle() },
      createElement('span', { style: { fontSize: 13 } }, fieldLabel(t, state.spec.field)),
      hint !== ''
        ? createElement('span', { style: { fontSize: 11.5, opacity: 0.5 } }, hint)
        : null,
    ),
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
      state.overridden ? createElement('span', { style: badgeStyle() }, t('overridden')) : null,
      state.overridden
        ? createElement('button', {
            type: 'button',
            disabled,
            className: 'dshm-btn',
            onClick: props.onReset,
            style: ghostButtonStyle(disabled),
          }, t('reset'))
        : null,
      control,
    ),
  )
}

/** Dropdown over the Host model catalog; empty value = deployment default. */
function ModelSelect(props: {
  t: (key: string) => string
  state: FieldState
  catalogModels: CatalogModel[]
  disabled: boolean
  onEdit: (text: string) => void
}) {
  const { t, state, catalogModels } = props
  const current = state.text
  const options = [createElement('option', { key: '__default__', value: '' }, t('modelDefault'))]
  for (const model of catalogModels) {
    const value = `${model.provider}/${model.model}`
    options.push(createElement('option', { key: value, value }, `${model.modelName} · ${model.providerName}`))
  }
  if (current !== '' && !catalogModels.some((model) => `${model.provider}/${model.model}` === current)) {
    options.push(createElement('option', { key: current, value: current }, current))
  }
  return createElement('select', {
    value: current,
    disabled: props.disabled,
    className: 'dshm-input',
    onChange: (event: { target: { value: string } }) => {
      props.onEdit(event.target.value)
    },
    style: inputStyle(false),
  }, options)
}

interface CommandsView {
  set(field: string, value: unknown): Promise<void>
}

/**
 * Import/export entry: the host-side transfer runs through the memory-commands
 * channel (path field + action), and the outcome comes back as a `transfer:`-
 * prefixed status detail line.
 */
function TransferSection(props: {
  t: (key: string) => string
  commands?: CommandsView
  statusDetail?: string
}) {
  const { t, commands } = props
  const [exportPath, setExportPath] = useState('')
  const [importPath, setImportPath] = useState('')
  const [requested, setRequested] = useState<'export' | 'import' | null>(null)

  const send = (action: 'export' | 'import', file: string): void => {
    if (commands == null || file.trim() === '') return
    setRequested(action)
    void (async () => {
      // Order matters: path and action must land before the timestamp trigger.
      await commands.set('path', file.trim())
      await commands.set('action', action)
      await commands.set('requestedAt', Date.now())
    })()
  }

  const feedback = props.statusDetail?.startsWith('transfer:') === true
    ? props.statusDetail.slice('transfer:'.length).trim()
    : null
  const feedbackIsError = feedback != null && /fail|need|must|unsupported|error/iu.test(feedback)

  const transferRow = (
    value: string,
    setValue: (next: string) => void,
    labelKey: string,
    action: 'export' | 'import',
  ) => {
    const empty = value.trim() === ''
    return createElement('div', { className: 'dshm-row', style: rowStyle() },
      createElement('div', { style: labelStackStyle() },
        createElement('span', { style: { fontSize: 13 } }, t(labelKey)),
      ),
      createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 } },
        createElement('input', {
          type: 'text',
          value,
          spellCheck: false,
          className: 'dshm-input',
          placeholder: 'C:\\…\\memory.dshmem.json',
          onChange: (event: { target: { value: string } }) => {
            setValue(event.target.value)
            setRequested(null)
          },
          style: inputStyle(false),
        }),
        createElement('button', {
          type: 'button',
          disabled: commands == null || empty,
          className: 'dshm-btn',
          onClick: () => send(action, value),
          style: primaryButtonStyle(commands == null || empty),
        }, t(`transfer_${action}`)),
      ),
    )
  }

  return createElement('section', { style: sectionStyle() },
    createElement('h3', { style: sectionHeaderStyle() }, t('group_transfer')),
    createElement('div', { style: { borderTop: `1px solid ${BORDER}` } },
      transferRow(exportPath, setExportPath, 'transfer_exportPath', 'export'),
      transferRow(importPath, setImportPath, 'transfer_importPath', 'import'),
    ),
    createElement('p', { style: { fontSize: 11.5, opacity: 0.5, margin: '8px 2px 0', lineHeight: 1.5 } },
      t('transfer_hint')),
    createElement('div', { style: { minHeight: 18, margin: '4px 2px 0' } },
      feedback != null
        ? createElement('span', { style: { fontSize: 12, color: feedbackIsError ? DANGER : 'inherit', opacity: feedbackIsError ? 1 : 0.8 } }, feedback)
        : requested != null
          ? createElement('span', { style: { fontSize: 12, opacity: 0.55 } }, t('transfer_requested'))
          : null,
    ),
  )
}

/** Collapsible section for the expert knobs (paths, retry tuning, denylist). */
function AdvancedSection(props: {
  t: (key: string) => string
  fields: FieldState[]
  disabled: boolean
  onEdit: (field: string, text: string) => void
  onReset: (field: string) => void
}) {
  const [open, setOpen] = useState(false)
  const { t } = props
  return createElement('section', { style: sectionStyle() },
    createElement('button', {
      type: 'button',
      className: 'dshm-advanced-head',
      onClick: () => setOpen(!open),
      style: {
        display: 'flex', alignItems: 'center', gap: 6, width: '100%',
        padding: '4px 6px 4px 2px', border: 'none', background: 'transparent',
        color: 'inherit', cursor: 'pointer', textAlign: 'left',
      },
    },
      createElement('span', {
        style: {
          fontSize: 9, opacity: 0.55, display: 'inline-block',
          transform: open ? 'rotate(90deg)' : 'none',
          transition: 'transform 150ms ease',
        },
      }, '▶'),
      createElement('span', { style: { ...sectionHeaderStyle(), margin: 0 } }, t('group_advanced')),
      !open
        ? createElement('span', { style: { fontSize: 11, opacity: 0.4 } }, `${props.fields.length}`)
        : null,
    ),
    open
      ? createElement('div', { style: { borderTop: `1px solid ${BORDER}` } },
          ...props.fields.map((field) => createElement(FieldRow, {
            key: field.spec.field,
            t,
            state: field,
            disabled: props.disabled,
            onEdit: (text: string) => props.onEdit(field.spec.field, text),
            onReset: () => props.onReset(field.spec.field),
          })),
        )
      : null,
  )
}

function fieldLabel(t: (key: string) => string, field: string): string {
  return t(`field_${field}`)
}

function hintText(t: (key: string) => string, field: string): string {
  const hint = t(`hint_${field}`)
  return hint === `hint_${field}` ? '' : hint
}

/**
 * The dedicated Memory settings page (occupies one `settings.section` seat):
 * live status banner, divided-list sections with catalog-backed model pickers
 * and toggle switches, transfer actions, and a collapsed advanced section.
 * Render failures surface inline instead of blanking the panel.
 */
export function MemorySettingsPage(props: Record<string, any>) {
  try {
    return renderMemoryPage(props)
  } catch (error) {
    return createElement('div', {
      style: { fontSize: 12.5, color: DANGER, maxWidth: 640, whiteSpace: 'pre-wrap' },
    }, `memory settings page error: ${String(error)}`)
  }
}

function renderMemoryPage(props: Record<string, any>) {
  if (props.useMemoryPage == null) {
    return createElement('div', { style: { fontSize: 13, opacity: 0.6 } }, 'renderer did not bind the memory page hook')
  }
  ensurePageStyles()
  const t: (key: string) => string = props.t
  const state: CardState = props.useMemoryPage((value: CardState) => value)
  const statusSnapshot = props.useMemoryStatus != null
    ? props.useMemoryStatus((value: unknown) => value) as
        | { status: string; value?: { phase?: string; detail?: string; updatedAt?: number } }
        | undefined
    : undefined
  if (!state.available) {
    return createElement('div', { style: { fontSize: 13, opacity: 0.6 } }, t('unavailable'))
  }
  const disabled = !state.writable

  const status = statusSnapshot?.status === 'ready' ? statusSnapshot.value : undefined
  const active = status?.phase === 'phase1' || status?.phase === 'phase2'
  const statusLabel = active
    ? (status?.phase === 'phase1' ? t('phase1') : t('phase2'))
    : t('statusIdle')

  const groups = new Map<string, FieldState[]>()
  for (const field of state.fields) {
    const list = groups.get(field.spec.group) ?? []
    list.push(field)
    groups.set(field.spec.group, list)
  }

  const fieldSection = (group: string) => {
    const fields = groups.get(group)
    if (fields == null || fields.length === 0) return null
    return createElement('section', { key: group, style: sectionStyle() },
      createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0 2px 2px' } },
        createElement('h3', { style: { ...sectionHeaderStyle(), margin: 0 } }, t(`group_${group}`)),
        group === 'models'
          ? createElement('button', {
              type: 'button',
              className: 'dshm-btn',
              onClick: props.refreshCatalog,
              style: { ...ghostButtonStyle(false), border: 'none', padding: '2px 6px', fontSize: 11.5 },
            }, state.catalogStatus === 'loading' ? t('catalogLoading') : t('catalogRefresh'))
          : null,
      ),
      group === 'models' && state.catalogStatus === 'error'
        ? createElement('div', { style: { fontSize: 11.5, color: DANGER, margin: '0 2px 4px' } }, t('catalogError'))
        : null,
      createElement('div', { style: { borderTop: `1px solid ${BORDER}` } },
        ...fields.map((field) => createElement(FieldRow, {
          key: field.spec.field,
          t,
          state: field,
          disabled,
          catalogModels: state.catalogModels,
          onEdit: (text: string) => props.edit(field.spec.field, text),
          onReset: () => props.resetField(field.spec.field),
        })),
      ),
    )
  }

  return createElement('div', { style: { maxWidth: 640, paddingBottom: 32 } },
    createElement('h2', { style: { fontSize: 19, fontWeight: 650, margin: '0 0 4px', letterSpacing: 0.2 } }, t('title')),
    createElement('p', { style: { fontSize: 13, opacity: 0.6, margin: '0 0 18px', lineHeight: 1.5 } }, t('intro')),
    // status banner
    createElement('div', {
      style: {
        border: `1px solid ${active ? ACCENT : BORDER}`,
        borderRadius: 10,
        padding: '10px 14px',
        display: 'flex', alignItems: 'center', gap: 10,
        background: active ? 'rgba(75, 123, 236, 0.07)' : 'transparent',
        transition: 'border-color 200ms ease, background 200ms ease',
      },
    },
      createElement('span', {
        style: {
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: active ? ACCENT : MUTED,
          animation: active ? 'dsh-memory-pulse 1.4s ease-in-out infinite' : undefined,
        },
      }),
      createElement('span', { style: { fontSize: 12.5, fontWeight: 600, flexShrink: 0 } }, statusLabel),
      status?.detail
        ? createElement('span', { style: { fontSize: 12, opacity: 0.6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, status.detail)
        : null,
      createElement('span', { style: { fontSize: 11, opacity: 0.4, marginLeft: 'auto', flexShrink: 0 } },
        status?.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : ''),
    ),
    fieldSection('general'),
    fieldSection('models'),
    fieldSection('schedule'),
    fieldSection('recall'),
    createElement(TransferSection, { t, commands: props.commands, statusDetail: status?.detail }),
    createElement(AdvancedSection, {
      t,
      fields: groups.get('advanced') ?? [],
      disabled,
      onEdit: (field: string, text: string) => props.edit(field, text),
      onReset: (field: string) => props.resetField(field),
    }),
    // Auto-save status line (no manual save/discard): edits commit on pause.
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginTop: 14, minHeight: 22 } },
      state.saving ? createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, t('saving')) : null,
      state.failed ? createElement('span', { style: { fontSize: 12, color: DANGER } }, t('failed')) : null,
      state.invalid ? createElement('span', { style: { fontSize: 12, color: DANGER } }, t('invalid')) : null,
      !state.writable ? createElement('span', { style: { fontSize: 12, opacity: 0.6 } }, t('readOnly')) : null,
    ),
  )
}
