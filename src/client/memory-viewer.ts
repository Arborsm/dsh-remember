/**
 * The standalone memory viewer: a right-sidebar page tab (same public path as
 * ui-sidebar-files) with four views — overview dashboard, summary (original /
 * translated), the MEMORY.md registry, and the stage-1 records table.
 *
 * Data arrives through the `memory-view` / `memory-status` settings mirrors:
 * a registration's `inject.hooks` compartment is synthesized by the slot
 * framework into `use<Name>` selector hooks (the same face the float uses for
 * `useMemoryStatus`). The large texts travel gzip+base64 in `blobs` and are
 * decoded with DecompressionStream. Actions go back through the
 * `memory-commands` namespace.
 */

import { createElement, useEffect, useState } from 'react'
import type { ScopeView } from './types.ts'

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

/** Published namespace section (texts compressed). */
interface ViewState {
  blobs: string
  records: string
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
  commands?: ScopeView
}

const EMPTY_TEXTS: Texts = { summary: '', index: '', translatedSummary: '', translatedIndex: '', failed: false }

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
    '.dshmv-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 10px; margin-bottom: 14px; }',
    '.dshmv-card { padding: 10px 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,0.04)); }',
    '.dshmv-card-num { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }',
    '.dshmv-card-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); margin-top: 2px; }',
    '.dshmv-md { white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.6; padding: 12px; border-radius: 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); background: var(--dsw-alias-fill-tertiary, rgba(0,0,0,0.04)); }',
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
    '.dshmv-badge { font-size: 10.5px; padding: 1px 8px; border-radius: 999px; }',
    '.dshmv-badge-stale { background: rgba(224,172,68,0.16); color: var(--dsw-alias-state-warn-primary, #b7791f); }',
    '.dshmv-badge-ok { background: rgba(84,196,138,0.16); color: var(--dsw-alias-state-success-primary, #2f9e63); }',
    '.dshmv-search { width: 100%; box-sizing: border-box; font-size: 12px; padding: 6px 10px; border-radius: 8px; border: 0.5px solid var(--dsw-alias-border-l3, rgba(0,0,0,0.18)); background: var(--dsw-alias-bg-layer-1, transparent); color: inherit; margin-bottom: 10px; outline: none; }',
    '.dshmv-search:focus { border-color: var(--dsw-alias-brand-primary, #4d6bfe); }',
    '.dshmv-table { width: 100%; border-collapse: collapse; font-size: 12px; }',
    '.dshmv-table th { text-align: left; font-weight: 600; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(0,0,0,0.1)); }',
    '.dshmv-table td { padding: 6px 8px; border-bottom: 0.5px solid var(--dsw-alias-border-l1, rgba(0,0,0,0.06)); vertical-align: top; }',
    '.dshmv-table tr:hover td { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }',
    '.dshmv-usage { display: flex; align-items: center; gap: 6px; }',
    '.dshmv-usage-bar { height: 5px; border-radius: 3px; background: var(--dsw-alias-brand-primary, #4d6bfe); min-width: 2px; transition: width 200ms ease; }',
    '.dshmv-empty { color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); padding: 24px 0; text-align: center; font-size: 12px; }',
    '.dshmv-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--dsw-alias-label-tertiary, rgba(0,0,0,0.45)); }',
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

type TabId = 'overview' | 'summary' | 'index' | 'records'

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
  const hasTranslation = texts.translatedSummary !== ''
  const translating = view.translating === true
  const sendCommand = (action: string, arg = '', force = false): void => {
    const commands = props.commands
    if (commands == null) return
    void (async () => {
      if (arg !== '') await commands.set('arg', arg)
      if (force) await commands.set('force', true)
      await commands.set('action', action)
      await commands.set('requestedAt', Date.now())
    })()
  }
  const effectiveText = showTranslated && hasTranslation ? texts.translatedSummary : texts.summary

  return createElement('div', { className: 'dshmv-root' },
    // tabs first: the action row sits below them, not against the pane header
    createElement('div', { className: 'dshmv-tabs' },
      ...(['overview', 'summary', 'index', 'records'] as const).map((id) => createElement('button', {
        key: id,
        type: 'button',
        className: 'dshmv-tab',
        'data-active': tab === id ? 'true' : 'false',
        onClick: () => setTab(id),
      }, t(`viewer_tab_${id}`))),
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
        ? `${t('viewer_translating')}${progressLabel(status.detail) === '' ? '' : ` ${progressLabel(status.detail)}`}`
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
      tab === 'overview' ? renderOverview(t, texts, effectiveText, showTranslated, status, records)
        : tab === 'summary' ? createElement(SummaryView, { t, texts, showTranslated })
          : tab === 'index' ? renderIndex(t, texts, showTranslated)
            : createElement(RecordsView, { t, records }),
    ),
  )
}

function renderOverview(
  t: (k: string) => string,
  texts: Texts,
  effectiveText: string,
  showTranslated: boolean,
  status: Partial<StatusState>,
  records: RecordStat[],
): ReactNode {
  const totalUsage = records.reduce((sum, record) => sum + record.usageCount, 0)
  const consolidated = records.filter((record) => record.selectedForPhase2).length
  const phase = status.phase ?? 'idle'
  const active = phase === 'phase1' || phase === 'phase2'
  const card = (num: ReactNode, label: string): ReactNode => createElement('div', { className: 'dshmv-card', key: label },
    createElement('div', { className: 'dshmv-card-num' }, num),
    createElement('div', { className: 'dshmv-card-label' }, label),
  )
  return createElement('div', { className: 'dshmv-fill' },
    createElement('div', { className: 'dshmv-cards' },
      card(records.length, t('viewer_stat_records')),
      card(consolidated, t('viewer_stat_consolidated')),
      card(totalUsage, t('viewer_stat_citations')),
      card(formatBytes(texts.summary.length), t('viewer_stat_summarySize')),
    ),
    createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 } },
      createElement('span', {
        className: `dshmv-badge ${active ? 'dshmv-badge-stale' : 'dshmv-badge-ok'}`,
      }, active ? (phase === 'phase1' ? t('phase1') : t('phase2')) : t('statusIdle')),
      status.updatedAt != null && status.updatedAt > 0
        ? createElement('span', { className: 'dshmv-mono' }, new Date(status.updatedAt).toLocaleString())
        : null,
      showTranslated ? createElement('span', { className: 'dshmv-badge dshmv-badge-ok' }, t('viewer_badgeTranslated')) : null,
    ),
    effectiveText !== '' || texts.summary !== ''
      ? createElement('div', { className: 'dshmv-md dshmv-md-fill' },
          effectiveText !== '' ? effectiveText : texts.summary)
      : createElement('div', { className: 'dshmv-empty dshmv-md-fill' }, texts.failed ? t('viewer_decodeFailed') : t('viewer_empty')),
  )
}

function SummaryView(props: { t: (k: string) => string; texts: Texts; showTranslated: boolean }) {
  const { t, texts, showTranslated } = props
  const text = showTranslated && texts.translatedSummary !== '' ? texts.translatedSummary : texts.summary
  return text !== ''
    ? createElement('div', { className: 'dshmv-md dshmv-md-fill' }, text)
    : createElement('div', { className: 'dshmv-empty dshmv-fill' }, texts.failed ? t('viewer_decodeFailed') : t('viewer_empty'))
}

function renderIndex(t: (k: string) => string, texts: Texts, showTranslated: boolean): ReactNode {
  const text = showTranslated && texts.translatedIndex !== '' ? texts.translatedIndex : texts.index
  return text !== ''
    ? createElement('div', { className: 'dshmv-md dshmv-md-fill' }, text)
    : createElement('div', { className: 'dshmv-empty dshmv-fill' }, texts.failed ? t('viewer_decodeFailed') : t('viewer_empty'))
}

function RecordsView(props: { t: (k: string) => string; records: RecordStat[] }) {
  const { t, records } = props
  const [query, setQuery] = useState('')
  const needle = query.trim().toLowerCase()
  const filtered = needle === ''
    ? records
    : records.filter((record) =>
        record.sessionId.toLowerCase().includes(needle)
        || record.rolloutSlug.toLowerCase().includes(needle)
        || record.workspacePath.toLowerCase().includes(needle))
  const maxUsage = Math.max(1, ...records.map((record) => record.usageCount))
  return createElement('div', { className: 'dshmv-fill' },
    createElement('input', {
      className: 'dshmv-search',
      placeholder: t('viewer_search'),
      value: query,
      onChange: (event: { target: { value: string } }) => setQuery(event.target.value),
    }),
    createElement('div', { className: 'dshmv-scroll-fill' },
      filtered.length === 0
        ? createElement('div', { className: 'dshmv-empty' }, t('viewer_empty'))
        : createElement('table', { className: 'dshmv-table' },
          createElement('thead', null, createElement('tr', null,
            createElement('th', null, t('viewer_col_session')),
            createElement('th', null, t('viewer_col_usage')),
            createElement('th', null, t('viewer_col_updated')),
          )),
          createElement('tbody', null,
            ...filtered.map((record) => createElement('tr', { key: record.sessionId },
              createElement('td', null,
                createElement('div', { style: { fontWeight: 600 } },
                  record.rolloutSlug || record.sessionId.slice(0, 8)),
                createElement('div', { className: 'dshmv-mono' }, record.workspacePath),
              ),
              createElement('td', null,
                createElement('div', { className: 'dshmv-usage' },
                  createElement('span', {
                    className: 'dshmv-usage-bar',
                    style: { width: `${Math.round((record.usageCount / maxUsage) * 48)}px` },
                  }),
                  createElement('span', null, String(record.usageCount)),
                ),
                record.lastUsage != null
                  ? createElement('div', { className: 'dshmv-mono' },
                      `${t('viewer_col_lastUsed')}: ${formatTime(record.lastUsage)}`)
                  : null,
              ),
              createElement('td', { className: 'dshmv-mono' }, formatTime(record.sourceUpdatedAt)),
            )),
          ),
        ),
    ),
  )
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KB`
}

function formatTime(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return '—'
  return new Date(unixSeconds * 1000).toLocaleString()
}

/** Current UI language tag for the translate command (`zh` vs `en`). */
function currentLang(): string {
  try {
    return (navigator.language || 'zh').toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {
    return 'zh'
  }
}
