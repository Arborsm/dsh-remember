/**
 * The memory entry in `sidebar.footer.action` — the fixed home of the status
 * surface, in the same seat as DSH's own Cordis panel. The trigger is a footer
 * row (a 36px circle in the collapsed rail) and the panel opens above it:
 * `position: fixed` with an offset measured from the trigger, because the
 * sidebar clips overflow and a 320px surface would otherwise be cut off.
 *
 * Reads the `memory-status` namespace through the client settings mirror
 * (phase/preview arrive via the forwarded settings/document-updated event —
 * no custom RPC) and acts through the `memory-commands` namespace the host
 * watches. Every action lives in the panel.
 */

import { createElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ScopeView } from './types.ts'

type SelectorHook = (selector: (value: unknown) => unknown) => unknown

let styleInjected = false

/** Inject the widget stylesheet once per document (factory-execution side effect). */
function ensureStyles(): void {
  if (styleInjected || typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-memory-float]') != null) {
    styleInjected = true
    return
  }
  const tag = document.createElement('style')
  tag.dataset.dshMemoryFloat = 'true'
  tag.textContent = [
    '@keyframes dsh-memory-pulse { 0% { opacity: 0.35; transform: scale(0.8); } 50% { opacity: 1; transform: scale(1.08); } 100% { opacity: 0.35; transform: scale(0.8); } }',
    '@keyframes dsh-memory-pop-in { from { opacity: 0; transform: translateY(6px) scale(0.96); } to { opacity: 1; transform: none; } }',
    // Trigger: the Settings trigger row's own geometry (42px row, 36px rail
    // cell, 8px icon inset) so the two foot rows line up.
    '.dshm-layer { position: relative; flex: 1 1 auto; display: flex; align-items: center; min-width: 0; width: calc(100% + 4px); height: 42px; margin: 4px -2px; }',
    '.dshm-layer[data-rail="true"] { flex: none; width: 36px; height: 36px; margin: 8px 0 0; }',
    '.dshm-foot { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; height: 42px; margin: 0; padding: 0 10px 0 8px; box-sizing: border-box; border: none; border-radius: 12px; background: transparent; color: var(--dsw-alias-label-primary, #eee); font-family: inherit; font-size: 14px; line-height: 22px; cursor: pointer; overflow: hidden; transition: background 150ms ease; }',
    '.dshm-foot:hover, .dshm-foot[data-open="true"] { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.12)); }',
    '.dshm-layer[data-rail="true"] .dshm-foot { flex: none; justify-content: center; gap: 0; width: 36px; height: 36px; padding: 0; border-radius: 50%; }',
    '.dshm-icon { position: relative; display: inline-flex; flex: none; align-items: center; justify-content: center; }',
    '.dshm-dot { position: absolute; right: -1px; bottom: -1px; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #4b7bec); animation: dsh-memory-pulse 1.4s ease-in-out infinite; }',
    '.dshm-foot-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.dshm-foot-state { flex: none; margin-left: auto; font-size: 12px; line-height: 16px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,0.9)); }',
    '.dshm-foot-state[data-active="true"] { color: var(--dsw-alias-brand-primary, #4b7bec); }',
    '.dshm-foot-state[data-paused="true"] { color: var(--dsw-alias-state-error-primary, #e05561); }',
    '.dshm-panel { animation: dsh-memory-pop-in 160ms ease; }',
    '.dshm-btn { transition: border-color 150ms ease, background 150ms ease, opacity 150ms ease, transform 100ms ease; }',
    '.dshm-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary, #4b7bec); opacity: 1; background: rgba(75, 123, 236, 0.12); }',
    '.dshm-btn:active:not(:disabled) { transform: translateY(1px); }',
    '.dshm-preview::-webkit-scrollbar { width: 6px; }',
    '.dshm-preview::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.35); border-radius: 3px; }',
    // Switch: DSH's own Switch primitive spec (36x20 track, 16px thumb), keyed
    // off aria-checked so the paint cannot disagree with assistive state.
    '.dshm-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; corner-shape: round; background: var(--dsw-alias-border-l3, rgba(128,128,128,0.45)); cursor: pointer; }',
    '.dshm-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary, #4b7bec); }',
    '.dshm-switch:disabled { cursor: default; opacity: 0.5; }',
    '.dshm-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #4b7bec); outline-offset: 2px; }',
    '.dshm-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground, #fff); transition: transform 120ms ease; }',
    '.dshm-switch[aria-checked="true"] .dshm-thumb { transform: translateX(16px); }',
    '.dshm-toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 3px 0; }',
  ].join('\n')
  document.head.appendChild(tag)
  styleInjected = true
}

export interface FloatStatus {
  phase: string
  detail: string
  summaryPreview: string
  updatedAt: number
}

interface ActionProps {
  t: (key: string) => string
  /** Owner prop of `sidebar.footer.action`: false while the sidebar is a rail. */
  wide?: boolean
  useMemoryStatus?: SelectorHook
  commands?: ScopeView
  settings?: ScopeView
  /** Opens the standalone memory viewer page (right sidebar tab). */
  openViewer?: () => void
}

/** The footer action component (slot component props: t + hooks + scopes). */
export function MemoryFooterAction(props: ActionProps) {
  try {
    return renderAction(props)
  } catch {
    return null
  }
}

function renderAction(props: ActionProps) {
  if (props.useMemoryStatus == null) return null
  ensureStyles()
  const t: (key: string) => string = props.t
  const wide = props.wide !== false

  const statusSnapshot = props.useMemoryStatus((value: unknown) => value) as
    | { status: string; value?: Partial<FloatStatus> }
    | undefined
  const status = statusSnapshot?.status === 'ready' ? statusSnapshot.value ?? {} : {}
  const phase = status.phase ?? 'idle'
  const active = phase === 'phase1' || phase === 'phase2'
  const phaseLabel = active
    ? (phase === 'phase1' ? t('phase1') : t('phase2'))
    : t('statusIdle')

  // Settings mirror for the quick toggles.
  const settingsSnapshot = useScopeSnapshot(props.settings)
  const settings = (settingsSnapshot?.value ?? {}) as Record<string, unknown>
  const settingsWritable = settingsSnapshot?.writable === true
  const scheduled = settings.generateMemories !== false

  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | undefined>(undefined)

  // The sidebar clips overflow, so the panel is position: fixed and hugs the
  // trigger through a measured offset instead of document flow.
  useLayoutEffect(() => {
    if (!open) return undefined
    const place = (): void => {
      const rect = rootRef.current?.getBoundingClientRect()
      if (rect != null) setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 8 })
    }
    place()
    window.addEventListener('resize', place)
    return () => { window.removeEventListener('resize', place) }
  }, [open, wide])

  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: Event): void => {
      const root = rootRef.current
      const target = event.target
      if (root != null && target instanceof Node && root.contains(target)) return
      setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const sendCommand = (action: string): void => {
    const commands = props.commands
    if (commands == null) return
    // Ordered: the host watch fires on the timestamp, so the action must land first.
    void (async () => {
      await commands.set('action', action)
      await commands.set('requestedAt', Date.now())
    })()
  }

  const toggleSetting = (field: string, value: unknown): void => {
    void props.settings?.set(field, value)
  }

  // The glyph carries the activity dot so the rail (icon only) still shows it.
  const icon = (size: number): unknown => createElement('span', { className: 'dshm-icon' },
    createElement(MemoryIcon, { size }),
    active ? createElement('span', { className: 'dshm-dot' }) : null,
  )

  // ── trigger ──────────────────────────────────────────────────────────────
  const trigger = createElement('button', {
    type: 'button',
    className: 'dshm-foot',
    'data-open': open ? 'true' : 'false',
    'aria-expanded': open,
    'aria-label': t('nav'),
    title: `${t('nav')} — ${scheduled ? phaseLabel : t('pausedBadge')}`,
    onClick: () => setOpen((value) => !value),
  },
    icon(wide ? 16 : 18),
    wide ? createElement('span', { className: 'dshm-foot-label' }, t('nav')) : null,
    wide
      ? createElement('span', {
          className: 'dshm-foot-state',
          'data-active': active ? 'true' : undefined,
          'data-paused': scheduled ? undefined : 'true',
        }, scheduled ? phaseLabel : t('pausedBadge'))
      : null,
  )

  const layer = (...children: unknown[]): unknown => createElement('div', {
    ref: rootRef as never,
    className: 'dshm-layer',
    'data-rail': wide ? undefined : 'true',
  }, ...children)

  if (!open) return layer(trigger)

  // ── panel: fixed above the trigger ───────────────────────────────────────
  const panelStyle: Record<string, unknown> = {
    position: 'fixed',
    zIndex: 40,
    width: 320,
    maxWidth: 'calc(100vw - 24px)',
    left: anchor?.left ?? 8,
    bottom: anchor?.bottom ?? 56,
    visibility: anchor == null ? 'hidden' : undefined,
    borderRadius: 14,
    overflow: 'hidden',
    background: 'var(--dsw-alias-bg-layer-3, rgba(20, 22, 28, 0.92))',
    backdropFilter: 'blur(14px)',
    WebkitBackdropFilter: 'blur(14px)',
    color: 'var(--dsw-alias-label-primary, #eee)',
    border: `1px solid ${BORDER}`,
    boxShadow: '0 10px 32px rgba(0,0,0,0.42)',
  }

  const preview = status.summaryPreview ?? ''

  return layer(
    trigger,
    createElement('div', { className: 'dshm-panel', style: panelStyle },
      createElement('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 12px',
          background: 'var(--dsw-alias-fill-tertiary, rgba(128,128,128,0.08))',
          borderBottom: `1px solid ${BORDER}`,
        },
      },
        icon(16),
        createElement('span', { style: { fontSize: 12.5, fontWeight: 600, flex: 1 } }, t('title')),
        createElement('button', {
          type: 'button',
          className: 'dshm-btn',
          title: t('minimize'),
          onClick: () => setOpen(false),
          style: {
            fontSize: 11, padding: '1px 8px', borderRadius: 6, cursor: 'pointer',
            border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', opacity: 0.75,
          },
        }, t('minimize')),
      ),
      createElement('div', { style: { padding: '10px 12px' } },
        createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
          createElement('span', { style: { fontSize: 12, fontWeight: 600 } }, phaseLabel),
          createElement('span', { style: { fontSize: 11, opacity: 0.45, marginLeft: 'auto' } },
            status.updatedAt ? new Date(status.updatedAt).toLocaleTimeString() : ''),
        ),
        status.detail !== ''
          ? createElement('div', { style: { fontSize: 11.5, opacity: 0.7, marginTop: 4 } }, status.detail)
          : null,
        createElement('div', {
          style: {
            display: 'flex', flexDirection: 'column', gap: 5, marginTop: 10,
            paddingTop: 10, borderTop: `1px solid ${BORDER}`,
          },
        },
          ...([
            ['enabled', 'field_enabled'],
            ['generateMemories', 'field_generateMemories'],
            ['useMemories', 'field_useMemories'],
          ] as const).map(([field, labelKey]) => createElement('div', {
            key: field,
            className: 'dshm-toggle-row',
          },
            createElement('span', { style: { fontSize: 12, opacity: 0.85 } }, t(labelKey)),
            createElement('button', {
              type: 'button',
              role: 'switch',
              'aria-checked': settings[field] === true,
              'aria-label': t(labelKey),
              className: 'dshm-switch',
              disabled: !settingsWritable,
              onClick: () => toggleSetting(field, settings[field] !== true),
            }, createElement('span', { className: 'dshm-thumb' })),
          )),
        ),
        preview !== ''
          ? createElement('div', {
              className: 'dshm-preview',
              style: {
                marginTop: 10, padding: '8px 10px', borderRadius: 8,
                background: 'var(--dsw-alias-fill-tertiary, rgba(128,128,128,0.08))',
                border: `1px solid ${BORDER}`,
                fontSize: 11, lineHeight: 1.5, opacity: 0.85,
                maxHeight: 130, overflowY: 'auto',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              },
            }, preview)
          : null,
      ),
      createElement('div', {
        style: {
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
          padding: '10px 12px 12px', borderTop: `1px solid ${BORDER}`,
        },
      },
        createElement('div', { style: { gridColumn: '1 / -1' } },
          actionButton(t('menuRunNow'), () => sendCommand('run-cycle'), true, true),
        ),
        props.openViewer != null
          ? actionButton(t('menuViewMemory'), () => props.openViewer?.(), false, true)
          : null,
        actionButton(scheduled ? t('menuPause') : t('menuResume'), () => sendCommand('toggle-schedule'), false, true),
        createElement('div', { style: { gridColumn: '1 / -1' } },
          actionButton(t('menuOpenFolder'), () => sendCommand('open-folder'), false, true),
        ),
      ),
    ),
  )
}

function actionButton(label: string, onClick: () => void, primary = false, stretch = false) {
  return createElement('button', {
    type: 'button',
    onClick,
    className: 'dshm-btn',
    style: {
      width: stretch ? '100%' : undefined,
      ...(primary
        ? {
            fontSize: 11.5, padding: '5px 10px', borderRadius: 7, cursor: 'pointer', fontWeight: 600,
            border: '1px solid transparent',
            background: 'var(--dsw-alias-button-info-fill, #4d6bfe)',
            color: 'var(--dsw-alias-label-primary-inverted, #fff)',
          }
        : {
            fontSize: 11.5, padding: '5px 10px', borderRadius: 7, cursor: 'pointer',
            border: `1px solid ${BORDER}`, background: 'transparent', color: 'inherit', opacity: 0.85,
          }),
    },
  }, label)
}

/** The memory glyph, inlined from ui-primitives' IconDatabaseOutline16: the
 * browser bundle externalizes react only, so host icons cannot be imported. */
function MemoryIcon({ size }: { size: number }) {
  return createElement('svg', {
    width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg', 'aria-hidden': 'true', focusable: 'false',
  },
    createElement('ellipse', { cx: 8, cy: 3.6, rx: 5.75, ry: 2.4, stroke: 'currentColor', strokeWidth: 1.25 }),
    createElement('path', { d: 'M2.25 3.6V12.3A5.75 2.4 0 0 0 13.75 12.3V3.6', stroke: 'currentColor', strokeWidth: 1.25 }),
    createElement('path', { d: 'M2.25 7.95A5.75 2.4 0 0 0 13.75 7.95', stroke: 'currentColor', strokeWidth: 1.25 }),
  )
}

function useScopeSnapshot(scope: ScopeView | undefined): { status: string; value?: unknown; writable?: boolean } | undefined {
  const [snapshot, setSnapshot] = useState<{ status: string; value?: unknown; writable?: boolean } | undefined>(
    () => scope?.getSnapshot(),
  )
  useEffect(() => {
    if (scope == null) return undefined
    setSnapshot(scope.getSnapshot())
    return scope.subscribe(() => {
      setSnapshot(scope.getSnapshot())
    })
  }, [scope])
  return snapshot
}

const BORDER = 'var(--dsw-alias-border-l2, rgba(255,255,255,0.14))'
