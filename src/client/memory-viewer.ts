/**
 * The standalone memory viewer: a right-sidebar page tab (same public path as
 * ui-sidebar-files) with five views — overview dashboard (stats, pipeline,
 * most-cited), a consolidation activity feed, the searchable records table,
 * summary (original / translated), and the MEMORY.md registry.
 *
 * Data arrives through the `memory` remote namespace: a registration's
 * `inject.hooks` compartment is synthesized by the slot framework into
 * `use<Name>` selector hooks (the same face the float uses for
 * `useMemoryStatus`). The large texts travel gzip+base64 in `blobs` and are
 * decoded with DecompressionStream. Actions go back through
 * `remote.memory.runCommand`.
 */

import { createElement, useEffect, useState } from 'react'
import type { CommandRunner } from './types.ts'

export const MEMORY_VIEWER_KIND = 'dsh-memory'
export const MEMORY_VIEWER_ID = 'dsh-remember/viewer'

type ReactNode = ReturnType<typeof createElement> | string | null
type SelectorHook = (selector: (value: unknown) => unknown) => unknown

interface RecordStat {
  sessionId: string
  workspacePath: string
  rolloutSlug: string
  sourceUpdatedAt: number
  generatedAt: number
  usageCount: number
  lastUsage: number | null
  selectedForPhase2: boolean
  rawLength: number
  summaryLength: number
}

/** One phase-2 run, mirrored from consolidation-log.jsonl. */
interface ConsolidationEntry {
  at: number
  result: string
  records: number
  changes: number
  staged: number
  durationMs: number
  preview: string
  error?: string
}

interface PipelineState {
  pending: number
  staged: number
  cooldownUntil: number | null
}

/** Published namespace section (texts compressed). */
interface ViewState {
  blobs: string
  records: string
  activity: string
  pipeline: string
  translatedStale: boolean
  translating: boolean
  updatedAt: number
}

interface Texts {
  summary: string
  index: string
  translatedSummary: string
  translatedIndex: string
  failed: boolean
}

interface StatusState {
  phase?: string
  detail?: string
  updatedAt?: number
}

interface ViewerProps {
  t: (key: string) => string
  useMemoryView?: SelectorHook
  useMemoryStatus?: SelectorHook
  commands?: CommandRunner
}

const EMPTY_TEXTS: Texts = { summary: '', index: '', translatedSummary: '', translatedIndex: '', failed: false }
const EMPTY_PIPELINE: PipelineState = { pending: 0, staged: 0, cooldownUntil: null }

let styleInjected = false

function ensureViewerStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-memory-viewer]') != null) {
    styleInjected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.dshMemoryViewer = 'true'
  tag.textContent = [
    '.dshmv-root { display: flex; flex-direction: column; height: 100%; min-height: 0; box-sizing: border-box; padding: 10px 14px 14px; color: var(--dsw-alias-label-primary, #1f2329); font-size: 13px; }',
    '.dshmv-tabs { display: flex; gap: 2px; flex: 0 0 auto; margin-bottom: 10px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }',
    '.dshmv-tab { padding: 6px 12px; font-size: 12.5px; cursor: pointer; border: none; background: none; color: inherit; opacity: 0.55; border-bottom: 2px solid transparent; transition: opacity 140ms ease, border-color 140ms ease; }',
    '.dshmv-tab:hover { opacity: 0.85; }',
    '.dshmv-tab[data-active="true"] { opacity: 1; border-bottom-color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }',
    '.dshmv-toolbar { display: flex; align-items: center; gap: 10px; flex: 0 0 auto; margin-bottom: 12px; flex-wrap: wrap; }',
    '.dshmv-status { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); }',
    '.dshmv-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; }',
    '.dshmv-body[data-fill="true"] { display: flex; flex-direction: column; overflow: hidden; }',
    '.dshmv-body::-webkit-scrollbar { width: 8px; }',
    '.dshmv-body::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l2, rgba(0,0,0,0.2)); border-radius: 4px; }',
    '.dshmv-switch-row { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: inherit; padding: 3px 8px; border-radius: 8px; border: 0.5px solid transparent; background: none; cursor: pointer; transition: background 150ms ease, opacity 150ms ease; }',
    '.dshmv-switch-row:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }',
    '.dshmv-switch-row:disabled { opacity: 0.45; cursor: default; }',
    // Switch: DSH's Switch primitive spec (36x20 track, 16px thumb), keyed off
    // aria-checked so the paint cannot disagree with assistive state.
    '.dshmv-switch { box-sizing: border-box; position: relative; display: inline-block; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; corner-shape: round; background: var(--dsw-alias-border-l3, rgba(0,0,0,0.2)); transition: background 160ms ease; }',
    '.dshmv-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #4d6bfe); }',
    '.dshmv-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }',
    '.dshmv-switch[aria-checked="true"] .dshmv-thumb { transform: translateX(16px); }',
    '.dshmv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; margin-bottom: 12px; }',
    '.dshmv-card { padding: 10px 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,0.04)); }',
    '.dshmv-card-num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.dshmv-card-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); margin-top: 2px; }',
    // Consolidation pipeline strip: next-run facts, same surface as a card.
    '.dshmv-pipe { display: flex; gap: 26px; flex-wrap: wrap; padding: 10px 12px; margin-bottom: 14px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,0.04)); }',
    '.dshmv-pipe-num { font-size: 15px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.dshmv-pipe-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); margin-top: 1px; }',
    // Live "run in progress" banner with a pulsing brand dot.
    '.dshmv-live { display: flex; align-items: center; gap: 9px; padding: 8px 12px; margin-bottom: 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-brand-primary, #4d6bfe); background: rgba(77,107,254,0.08); background: color-mix(in srgb, var(--dsw-alias-brand-primary, #4d6bfe) 10%, transparent); font-size: 12px; }',
    '.dshmv-dot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4d6bfe); animation: dshmv-pulse 1.4s ease-in-out infinite; }',
    '@keyframes dshmv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }',
    // Rendered markdown surface for the summary / registry tabs.
    '.dshmv-md { overflow-wrap: break-word; font-size: 12.5px; line-height: 1.65; padding: 14px 16px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,0.04)); }',
    '.dshmv-md > :first-child { margin-top: 0; }',
    '.dshmv-md-h1 { font-size: 15px; font-weight: 700; margin: 12px 0 4px; }',
    '.dshmv-md-h2 { font-size: 14px; font-weight: 650; margin: 10px 0 4px; }',
    '.dshmv-md-h3 { font-size: 13px; font-weight: 600; margin: 8px 0 3px; }',
    '.dshmv-md-h4 { font-size: 12.5px; font-weight: 600; margin: 8px 0 3px; }',
    '.dshmv-md-p { margin: 4px 0; }',
    '.dshmv-md-list { margin: 4px 0; padding-left: 20px; }',
    '.dshmv-md-list li { margin: 2px 0; }',
    '.dshmv-md-code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; padding: 0 4px; border-radius: 4px; background: var(--dsw-alias-border-l2, rgba(0,0,0,0.08)); }',
    '.dshmv-md-hr { border: none; border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.12)); margin: 10px 0; }',
    '.dshmv-md-fill { flex: 1 1 auto; min-height: 0; overflow: auto; }',
    '.dshmv-scroll-fill { flex: 1 1 auto; min-height: 0; overflow: auto; }',
    '.dshmv-fill { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }',
    '.dshmv-btn { font-size: 12px; padding: 4px 12px; border-radius: 7px; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.2)); background: transparent; color: inherit; transition: border-color 150ms ease, background 150ms ease, transform 100ms ease; }',
    '.dshmv-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4d6bfe); background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05)); }',
    '.dshmv-btn:active:not(:disabled) { transform: translateY(1px); }',
    '.dshmv-btn:disabled { opacity: 0.4; cursor: default; }',
    '.dshmv-btn-primary { border-color: transparent; background: var(--dsw-alias-button-info-fill, #4d6bfe); color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 600; }',
    '.dshmv-btn-primary:hover:not(:disabled) { border-color: transparent; background: var(--dsw-alias-button-info-hover, #3f5ae0); }',
    '.dshmv-btn-danger { border-color: transparent; background: var(--dsw-alias-state-error-primary, #d54941); color: var(--dsw-alias-label-primary-inverted, #fff); font-weight: 600; }',
    '.dshmv-btn-danger:hover:not(:disabled) { border-color: transparent; filter: brightness(1.08); }',
    '.dshmv-confirm { display: inline-flex; align-items: center; gap: 6px; padding: 2px 6px 2px 10px; border-radius: 8px; background: rgba(213,73,65,0.12); }',
    '.dshmv-confirm-text { font-size: 11.5px; color: var(--dsw-alias-state-error-primary, #d54941); }',
    '.dshmv-badge { font-size: 11px; padding: 1px 8px; border-radius: 999px; border: 0.5px solid; white-space: nowrap; }',
    '.dshmv-badge-ok { color: var(--dsw-alias-state-success-primary, #2ba471); border-color: var(--dsw-alias-state-success-primary, #2ba471); }',
    '.dshmv-badge-warn { color: var(--dsw-alias-state-warn-primary, #d9730d); border-color: var(--dsw-alias-state-warn-primary, #d9730d); }',
    '.dshmv-badge-stale { color: var(--dsw-alias-state-warn-primary, #d9730d); border-color: var(--dsw-alias-state-warn-primary, #d9730d); }',
    '.dshmv-badge-err { color: var(--dsw-alias-state-error-primary, #d54941); border-color: var(--dsw-alias-state-error-primary, #d54941); }',
    '.dshmv-badge-muted { color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); border-color: var(--dsw-alias-border-l3, rgba(0,0,0,0.2)); }',
    '.dshmv-section { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary, rgba(0,0,0,0.6)); margin-bottom: 8px; }',
    '.dshmv-search { box-sizing: border-box; width: 100%; max-width: 320px; font-size: 12px; padding: 5px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.15)); background: transparent; color: inherit; margin-bottom: 8px; }',
    '.dshmv-search:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }',
    '.dshmv-chips { display: flex; gap: 6px; margin-bottom: 10px; }',
    '.dshmv-chip { font-size: 11.5px; padding: 3px 10px; border-radius: 999px; cursor: pointer; border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.2)); background: transparent; color: var(--dsw-alias-label-secondary, rgba(0,0,0,0.6)); transition: border-color 140ms ease, color 140ms ease; }',
    '.dshmv-chip:hover { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }',
    '.dshmv-chip[data-active="true"] { border-color: var(--dsw-alias-brand-primary, #4d6bfe); color: var(--dsw-alias-brand-primary, #4d6bfe); font-weight: 600; }',
    '.dshmv-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    '.dshmv-table th { text-align: left; font-weight: 600; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); padding: 4px 10px 6px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }',
    '.dshmv-table td { padding: 7px 10px 7px 0; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.06)); vertical-align: top; }',
    '.dshmv-session { font-weight: 600; }',
    '.dshmv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); }',
    '.dshmv-usage { display: flex; align-items: center; gap: 6px; }',
    '.dshmv-usage-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-brand-primary, #4d6bfe); }',
    '.dshmv-toprow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; padding: 7px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); margin-bottom: 6px; }',
    '.dshmv-toprow-name { font-weight: 600; }',
    '.dshmv-toprow-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); white-space: nowrap; }',
    '.dshmv-feed { display: flex; flex-direction: column; gap: 8px; }',
    '.dshmv-feed-item { padding: 9px 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }',
    '.dshmv-feed-head { display: flex; align-items: center; gap: 8px; }',
    '.dshmv-feed-time { margin-left: auto; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); white-space: nowrap; }',
    '.dshmv-feed-meta { margin-top: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); font-variant-numeric: tabular-nums; }',
    '.dshmv-feed-preview { margin-top: 6px; font-size: 12px; white-space: pre-wrap; overflow-wrap: break-word; }',
    '.dshmv-feed-error { color: var(--dsw-alias-state-error-primary, #d54941); }',
    '.dshmv-empty { padding: 24px; text-align: center; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); font-size: 12px; }',
  ].join('\n')
  document.head.appendChild(tag)
  styleInjected = true
}

/** Read one namespace mirror through its selector hook (framework-synthesized). */
function useMirror<T>(hook: SelectorHook | undefined): Partial<T> {
  const snapshot = hook?.((value: unknown) => value) as { status?: string; value?: Partial<T> } | undefined
  return snapshot?.status === 'ready' ? snapshot.value ?? {} : {}
}

/** Decode the gzip+base64 texts; DecompressionStream is the only browser dependency. */
function useBlobs(encoded: string | undefined): Texts {
  const [texts, setTexts] = useState<Texts>(EMPTY_TEXTS)
  useEffect(() => {
    if (encoded == null || encoded === '') {
      setTexts(EMPTY_TEXTS)
      return undefined
    }
    let cancelled = false
    void decodeBlobs(encoded)
      .then((next) => { if (!cancelled) setTexts(next) })
      .catch(() => { if (!cancelled) setTexts({ ...EMPTY_TEXTS, failed: true }) })
    return () => { cancelled = true }
  }, [encoded])
  return texts
}

async function decodeBlobs(encoded: string): Promise<Texts> {
  if (typeof DecompressionStream === 'undefined') return { ...EMPTY_TEXTS, failed: true }
  const binary = atob(encoded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const stream = new DecompressionStream('gzip')
  const writer = stream.writable.getWriter()
  void writer.write(bytes)
  void writer.close()
  const parsed = JSON.parse(await new Response(stream.readable).text()) as Partial<Texts>
  return {
    summary: parsed.summary ?? '',
    index: parsed.index ?? '',
    translatedSummary: parsed.translatedSummary ?? '',
    translatedIndex: parsed.translatedIndex ?? '',
    failed: false,
  }
}

type TabId = 'overview' | 'activity' | 'records' | 'summary' | 'index'
const TAB_IDS: readonly TabId[] = ['overview', 'activity', 'records', 'summary', 'index']

/** Viewer body (slot component). */
export function MemoryViewerBody(props: ViewerProps) {
  try {
    return renderViewer(props)
  } catch {
    return null
  }
}

function renderViewer(props: ViewerProps) {
  ensureViewerStyles()
  const t = props.t
  const view = useMirror<ViewState>(props.useMemoryView)
  const status = useMirror<StatusState>(props.useMemoryStatus)
  const texts = useBlobs(view.blobs)
  const [tab, setTab] = useState<TabId>('overview')
  const [showTranslated, setShowTranslated] = useState(false)
  const [confirmingRebuild, setConfirmingRebuild] = useState(false)

  const records = parseRecords(view.records)
  const entries = parseActivity(view.activity)
  const pipeline = parsePipeline(view.pipeline)
  const hasTranslation = texts.translatedSummary !== ''
  const translating = view.translating === true
  const sendCommand = (action: string, arg = '', force = false): void => {
    const commands = props.commands
    if (commands == null) return
    void commands.run({ action, arg: arg === '' ? undefined : arg, force: force || undefined })
  }

  return createElement('div', { className: 'dshmv-root' },
    // tabs first: the action row sits below them, not against the pane header
    createElement('div', { className: 'dshmv-tabs' },
      ...TAB_IDS.map((id) => createElement('button', {
        key: id,
        type: 'button',
        className: 'dshmv-tab',
        'data-active': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, t('viewer_tab_' + id))),
    ),
    createElement('div', { className: 'dshmv-toolbar' },
      createElement('button', {
        type: 'button',
        className: 'dshmv-btn',
        onClick: () => sendCommand('refresh-view'),
      }, t('viewer_refresh')),
      // The switch is a pure view toggle; fetching a translation is the
      // separate action button below it.
      createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': showTranslated && hasTranslation,
        disabled: !hasTranslation || translating,
        className: 'dshmv-switch-row',
        onClick: () => setShowTranslated((value) => !value),
      },
        createElement('span', null, t('viewer_showTranslated')),
        createElement('span', {
          className: 'dshmv-switch',
          'aria-checked': showTranslated && hasTranslation ? 'true' : 'false',
        }, createElement('span', { className: 'dshmv-thumb' })),
      ),
      createElement('button', {
        type: 'button',
        className: translating ? 'dshmv-btn' : 'dshmv-btn dshmv-btn-primary',
        disabled: translating || texts.summary === '',
        onClick: () => sendCommand('translate-memory', currentLang()),
      }, translating
        ? t('viewer_translating') + (progressLabel(status.detail) === '' ? '' : ' ' + progressLabel(status.detail))
        : hasTranslation ? t('viewer_retranslate') : t('viewer_translate')),
      // Two-step confirm: the destructive full rebuild never fires on one click.
      confirmingRebuild
        ? createElement('span', { className: 'dshmv-confirm' },
            createElement('span', { className: 'dshmv-confirm-text' }, t('viewer_rebuildConfirm')),
            createElement('button', {
              type: 'button',
              className: 'dshmv-btn dshmv-btn-danger',
              disabled: translating || texts.summary === '',
              onClick: () => {
                setConfirmingRebuild(false)
                sendCommand('translate-memory', currentLang(), true)
              },
            }, t('viewer_confirm')),
            createElement('button', {
              type: 'button',
              className: 'dshmv-btn',
              onClick: () => setConfirmingRebuild(false),
            }, t('viewer_cancel')),
          )
        : createElement('button', {
            type: 'button',
            className: 'dshmv-btn',
            disabled: translating || texts.summary === '',
            onClick: () => setConfirmingRebuild(true),
          }, t('viewer_rebuild')),
      showTranslated && hasTranslation && view.translatedStale === true
        ? createElement('span', { className: 'dshmv-badge dshmv-badge-stale' }, t('viewer_stale'))
        : null,
      showTranslated && hasTranslation && view.translatedStale !== true
        ? createElement('span', { className: 'dshmv-badge dshmv-badge-ok' }, t('viewer_fresh'))
        : null,
      createElement('span', { className: 'dshmv-status' }, status.detail ?? ''),
    ),
    createElement('div', {
      className: 'dshmv-body',
      // Every tab fills the pane; its content block does the scrolling.
      'data-fill': 'true',
    },
      tab === 'overview' ? createElement(OverviewView, { t, texts, status, records, pipeline })
        : tab === 'activity' ? createElement(ActivityView, { t, status, entries })
          : tab === 'records' ? createElement(RecordsView, { t, records })
            : tab === 'summary' ? createElement(SummaryView, { t, texts, showTranslated })
              : renderIndex(t, texts, showTranslated),
    ),
  )
}

/** Pulsing "run in progress" banner for any non-idle pipeline phase. */
function liveRow(t: (k: string) => string, status: Partial<StatusState>): ReactNode {
  const phase = status.phase
  if (phase == null || phase === 'idle') return null
  const label = status.detail && status.detail !== ''
    ? status.detail
    : phase === 'phase1' || phase === 'phase2' || phase === 'processing' ? t(phase) : phase
  return createElement('div', { className: 'dshmv-live' },
    createElement('span', { className: 'dshmv-dot' }),
    createElement('span', null, label),
  )
}

/** Overview dashboard: stat cards, pipeline strip, most-cited list. */
function OverviewView(props: {
  t: (k: string) => string
  texts: Texts
  status: Partial<StatusState>
  records: RecordStat[]
  pipeline: PipelineState
}) {
  const { t, texts, status, records, pipeline } = props
  const topCited = records
    .filter((record) => record.usageCount > 0)
    .sort((a, b) => b.usageCount - a.usageCount)
    .slice(0, 5)
  const totalUsage = records.reduce((sum, record) => sum + record.usageCount, 0)
  const consolidated = records.filter((record) => record.selectedForPhase2).length
  const card = (label: string, value: string | number): ReactNode => createElement('div', { className: 'dshmv-card', key: label },
    createElement('div', { className: 'dshmv-card-num' }, String(value)),
    createElement('div', { className: 'dshmv-card-label' }, label),
  )
  const pipeCell = (label: string, value: string): ReactNode => createElement('div', { key: label },
    createElement('div', { className: 'dshmv-pipe-num' }, value),
    createElement('div', { className: 'dshmv-pipe-label' }, label),
  )
  const cooldown = pipeline.cooldownUntil != null && pipeline.cooldownUntil * 1000 > Date.now()
    ? formatTime(pipeline.cooldownUntil)
    : '—'
  return createElement('div', { className: 'dshmv-scroll-fill' },
    liveRow(t, status),
    createElement('div', { className: 'dshmv-cards' },
      card(t('viewer_stat_records'), records.length),
      card(t('viewer_stat_consolidated'), consolidated),
      card(t('viewer_stat_citations'), totalUsage),
      card(t('viewer_stat_summarySize'), formatBytes(texts.summary.length)),
      card(t('viewer_stat_indexSize'), formatBytes(texts.index.length)),
    ),
    createElement('div', { className: 'dshmv-pipe' },
      pipeCell(t('viewer_pipeline_pending'), String(pipeline.pending)),
      pipeCell(t('viewer_pipeline_staged'), String(pipeline.staged)),
      pipeCell(t('viewer_pipeline_cooldown'), cooldown),
    ),
    records.length === 0
      ? null
      : createElement('div', { className: 'dshmv-section' }, t('viewer_topCited')),
    ...topCited.map((record) => createElement('div', { className: 'dshmv-toprow', key: record.sessionId },
      createElement('span', { className: 'dshmv-toprow-name' }, record.rolloutSlug || record.sessionId.slice(0, 8)),
      createElement('span', { className: 'dshmv-toprow-meta' },
        record.usageCount + ' · ' + formatTime(record.lastUsage ?? record.sourceUpdatedAt)),
    )),
    records.length > 0 && topCited.length === 0
      ? createElement('div', { className: 'dshmv-empty' }, t('viewer_noCitations'))
      : null,
  )
}

/** Consolidation feed: live row on top, then the persisted run history. */
function ActivityView(props: {
  t: (k: string) => string
  status: Partial<StatusState>
  entries: ConsolidationEntry[]
}) {
  const { t, status, entries } = props
  return createElement('div', { className: 'dshmv-scroll-fill' },
    liveRow(t, status),
    entries.length === 0
      ? createElement('div', { className: 'dshmv-empty' }, t('viewer_activity_empty'))
      : createElement('div', { className: 'dshmv-feed' },
          ...entries.map((entry) => {
            const preview = entry.error && entry.error !== '' ? entry.error : entry.preview
            return createElement('div', { className: 'dshmv-feed-item', key: entry.at + '-' + entry.result },
              createElement('div', { className: 'dshmv-feed-head' },
                resultBadge(t, entry.result),
                createElement('span', { className: 'dshmv-feed-time' }, formatAgo(t, entry.at)),
              ),
              createElement('div', { className: 'dshmv-feed-meta' },
                t('viewer_meta_records') + ' ' + entry.records
                  + ' · ' + t('viewer_meta_changes') + ' ' + entry.changes
                  + ' · ' + t('viewer_meta_staged') + ' ' + entry.staged
                  + ' · ' + Math.round(entry.durationMs / 1000) + 's'),
              preview === ''
                ? null
                : createElement('div', {
                    className: 'dshmv-feed-preview' + (entry.error && entry.error !== '' ? ' dshmv-feed-error' : ''),
                  }, preview.length > 400 ? preview.slice(0, 400) + '…' : preview),
            )
          }),
        ),
  )
}

function resultBadge(t: (k: string) => string, result: string): ReactNode {
  const tone = result === 'consolidated' ? 'dshmv-badge-ok'
    : result === 'failed' ? 'dshmv-badge-err'
      : 'dshmv-badge-muted'
  const key = 'viewer_result_' + result
  const label = result === 'consolidated' || result === 'no-changes' || result === 'failed' ? t(key) : result
  return createElement('span', { className: 'dshmv-badge ' + tone }, label)
}

/** Records table: search + status filter chips + per-record columns. */
function RecordsView(props: { t: (k: string) => string; records: RecordStat[] }) {
  const { t, records } = props
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'pending' | 'done'>('all')
  const needle = query.trim().toLowerCase()
  const filtered = records.filter((record) =>
    (filter === 'all' || (filter === 'done') === record.selectedForPhase2)
    && (needle === ''
      || record.sessionId.toLowerCase().includes(needle)
      || record.rolloutSlug.toLowerCase().includes(needle)
      || record.workspacePath.toLowerCase().includes(needle)))
  const maxUsage = Math.max(1, ...records.map((record) => record.usageCount))
  const chip = (id: 'all' | 'pending' | 'done', label: string): ReactNode => createElement('button', {
    key: id,
    type: 'button',
    className: 'dshmv-chip',
    'data-active': filter === id ? 'true' : 'false',
    onClick: () => setFilter(id),
  }, label)
  return createElement('div', { className: 'dshmv-fill' },
    createElement('input', {
      className: 'dshmv-search',
      placeholder: t('viewer_search'),
      value: query,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
    createElement('div', { className: 'dshmv-chips' },
      chip('all', t('viewer_filter_all')),
      chip('pending', t('viewer_status_pending')),
      chip('done', t('viewer_stat_consolidated')),
    ),
    filtered.length === 0
      ? createElement('div', { className: 'dshmv-empty' }, t('viewer_empty'))
      : createElement('div', { className: 'dshmv-scroll-fill' },
          createElement('table', { className: 'dshmv-table' },
            createElement('thead', null,
              createElement('tr', null,
                createElement('th', null, t('viewer_col_session')),
                createElement('th', null, t('viewer_col_status')),
                createElement('th', null, t('viewer_col_usage')),
                createElement('th', null, t('viewer_col_generated')),
                createElement('th', null, t('viewer_col_updated')),
              ),
            ),
            createElement('tbody', null,
              ...filtered.map((record) => createElement('tr', { key: record.sessionId },
                createElement('td', null,
                  createElement('div', { className: 'dshmv-session' },
                    record.rolloutSlug || record.sessionId.slice(0, 8)),
                  createElement('div', { className: 'dshmv-mono' }, record.workspacePath),
                ),
                createElement('td', null,
                  record.selectedForPhase2
                    ? createElement('span', { className: 'dshmv-badge dshmv-badge-ok' }, t('viewer_stat_consolidated'))
                    : createElement('span', { className: 'dshmv-badge dshmv-badge-warn' }, t('viewer_status_pending')),
                ),
                createElement('td', null,
                  createElement('div', { className: 'dshmv-usage' },
                    createElement('span', {
                      className: 'dshmv-usage-bar',
                      style: { width: Math.round((record.usageCount / maxUsage) * 48) + 'px' },
                    }),
                    createElement('span', null, String(record.usageCount)),
                  ),
                  record.lastUsage != null
                    ? createElement('div', { className: 'dshmv-mono' },
                        t('viewer_col_lastUsed') + ': ' + formatTime(record.lastUsage))
                    : null,
                ),
                createElement('td', { className: 'dshmv-mono' }, formatTime(record.generatedAt)),
                createElement('td', { className: 'dshmv-mono' }, formatTime(record.sourceUpdatedAt)),
              )),
            ),
          ),
        ),
  )
}

function SummaryView(props: { t: (k: string) => string; texts: Texts; showTranslated: boolean }) {
  const { t, texts, showTranslated } = props
  const text = showTranslated && texts.translatedSummary !== '' ? texts.translatedSummary : texts.summary
  return text !== ''
    ? createElement('div', { className: 'dshmv-md dshmv-md-fill' }, ...renderMd(text))
    : createElement('div', { className: 'dshmv-empty dshmv-fill' }, texts.failed ? t('viewer_decodeFailed') : t('viewer_empty'))
}

function renderIndex(t: (k: string) => string, texts: Texts, showTranslated: boolean): ReactNode {
  const text = showTranslated && texts.translatedIndex !== '' ? texts.translatedIndex : texts.index
  return text !== ''
    ? createElement('div', { className: 'dshmv-md dshmv-md-fill' }, ...renderMd(text))
    : createElement('div', { className: 'dshmv-empty dshmv-fill' }, texts.failed ? t('viewer_decodeFailed') : t('viewer_empty'))
}

/** Inline markdown: **bold**, *italic*, `code`. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g)
  return parts.map((part, index) => {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      return createElement('strong', { key: keyPrefix + index }, part.slice(2, -2))
    }
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      return createElement('code', { key: keyPrefix + index, className: 'dshmv-md-code' }, part.slice(1, -1))
    }
    if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      return createElement('em', { key: keyPrefix + index }, part.slice(1, -1))
    }
    return part === '' ? null : part
  })
}

/**
 * Lite markdown renderer: headings, unordered/ordered lists, horizontal rules,
 * paragraphs and the inline styles above. No fenced code blocks — memory files
 * are prose, so unhandled markup degrades to literal text instead of noise.
 */
function renderMd(text: string): ReactNode[] {
  const blocks: ReactNode[] = []
  const paragraph: string[] = []
  let list: string[] = []
  let listOrdered = false
  let key = 0
  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    blocks.push(createElement('div', { key: key++, className: 'dshmv-md-p' }, ...renderInline(paragraph.join(' '), 'p')))
    paragraph.length = 0
  }
  const flushList = (): void => {
    if (list.length === 0) return
    blocks.push(createElement(listOrdered ? 'ol' : 'ul', { key: key++, className: 'dshmv-md-list' },
      ...list.map((item, index) => createElement('li', { key: index }, ...renderInline(item, 'li' + index + '-')))))
    list = []
  }
  for (const line of text.split('\n')) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading != null) {
      flushParagraph(); flushList()
      const level = Math.min(4, Math.max(1, heading[1]?.length ?? 1))
      blocks.push(createElement('div', { key: key++, className: 'dshmv-md-h' + level }, heading[2] ?? ''))
      continue
    }
    if (/^\s*$/.test(line)) {
      flushParagraph(); flushList()
      continue
    }
    if (/^---+\s*$/.test(line)) {
      flushParagraph(); flushList()
      blocks.push(createElement('hr', { key: key++, className: 'dshmv-md-hr' }))
      continue
    }
    const unordered = /^\s*[-•*]\s+(.*)$/.exec(line)
    if (unordered != null) {
      flushParagraph()
      if (list.length > 0 && listOrdered) flushList()
      listOrdered = false
      list.push(unordered[1] ?? '')
      continue
    }
    const ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line)
    if (ordered != null) {
      flushParagraph()
      if (list.length > 0 && !listOrdered) flushList()
      listOrdered = true
      list.push(ordered[1] ?? '')
      continue
    }
    flushList()
    paragraph.push(line.trim())
  }
  flushParagraph(); flushList()
  return blocks
}

/** Title chip for the viewer tab. */
export function MemoryViewerTitle(props: { t: (key: string) => string }) {
  return createElement('span', null, props.t('viewer_title'))
}

/** 'N/M' extracted from the host's `translate: N/M chunks` status line. */
function progressLabel(detail: string | undefined): string {
  return /translate:\s*(\d+\/\d+)/.exec(detail ?? '')?.[1] ?? ''
}

function parseRecords(raw: string | undefined): RecordStat[] {
  if (raw == null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as RecordStat[] : []
  } catch {
    return []
  }
}

function parseActivity(raw: string | undefined): ConsolidationEntry[] {
  if (raw == null || raw === '') return []
  try {
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed as ConsolidationEntry[] : []
  } catch {
    return []
  }
}

function parsePipeline(raw: string | undefined): PipelineState {
  if (raw == null || raw === '') return EMPTY_PIPELINE
  try {
    const parsed = JSON.parse(raw) as Partial<PipelineState>
    return {
      pending: typeof parsed.pending === 'number' ? parsed.pending : 0,
      staged: typeof parsed.staged === 'number' ? parsed.staged : 0,
      cooldownUntil: typeof parsed.cooldownUntil === 'number' ? parsed.cooldownUntil : null,
    }
  } catch {
    return EMPTY_PIPELINE
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  return (bytes / 1024).toFixed(1) + ' KB'
}

function formatTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—'
  return new Date(unixSeconds * 1000).toLocaleString()
}

/** Relative timestamp for the activity feed; dates past a day. */
function formatAgo(t: (k: string) => string, ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return t('viewer_time_justNow')
  if (diff < 3_600_000) return t('viewer_time_minAgo').replace('{n}', String(Math.max(1, Math.round(diff / 60_000))))
  if (diff < 86_400_000) return t('viewer_time_hourAgo').replace('{n}', String(Math.round(diff / 3_600_000)))
  return new Date(ms).toLocaleString()
}

/** Current UI language tag for the translate command (`zh` vs `en`). */
function currentLang(): string {
  try {
    return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}
