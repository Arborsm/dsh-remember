/**
 * Browser half of dsh-memory-plugin: contributes the Settings → Plugins card
 * for the `memory` namespace and the memory entry in the sidebar footer.
 * Registered lazily via slots.inject so composition order never matters.
 */

import { MemoryCardController, MemorySettingsPage } from './memory-card.ts'
import { MemoryFooterAction } from './sidebar-action.ts'
import { installCitationStripper } from './citation-stripper.ts'
import { MEMORY_VIEWER_ID, MEMORY_VIEWER_KIND, MemoryViewerBody, MemoryViewerTitle } from './memory-viewer.ts'
import type { CatalogModel, ClientContext } from './types.ts'

export const name = 'dsh-memory-plugin'

/** Required browser services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'settingsScope', 'remote', 'remote.session']

const NS = 'dsh-memory'

const ZH: Record<string, string> = {
  nav: '记忆',
  title: '记忆系统',
  intro: '空闲会话自动提取、整理为可检索的文件型记忆库,并在对话中按需召回。',
  unavailable: '此部署未提供记忆设置(命名空间不可用)。',
  group_general: '通用',
  group_models: '模型',
  group_schedule: '调度与保留',
  group_recall: '召回注入',
  group_transfer: '导入 / 导出',
  group_advanced: '高级',
  field_enabled: '启用记忆系统',
  field_generateMemories: '自动生成记忆',
  field_useMemories: '注入记忆摘要',
  field_workspaceDir: '记忆工作区目录',
  field_dbPath: 'SQLite 数据库路径',
  field_extractModel: '提取模型 (provider/model)',
  field_consolidationModel: '整理模型 (provider/model)',
  field_scanIntervalMinutes: '扫描间隔(分钟)',
  field_minRolloutIdleHours: '会话静置阈值(小时)',
  field_maxSessionAgeDays: '会话最大年龄(天)',
  field_maxUnusedDays: '未用记忆保留(天)',
  field_maxRolloutSummaries: 'rollout 摘要上限',
  field_phase2SuccessCooldownSeconds: '整理成功冷却(秒)',
  field_phase2TimeoutMinutes: '整理超时(分钟)',
  field_phase1RetryBackoffMinutes: '提取重试退避(分钟)',
  field_phase1MaxRetries: '提取重试次数',
  field_phase1MaxPerCycle: '每轮提取上限',
  field_phase1MaxConcurrency: '提取并发数',
  field_consolidatorDenyPatterns: '整理器额外工具黑名单(正则)',
  field_summaryTokenLimit: '摘要注入 token 上限',
  field_extractInputContextRatio: '提取上下文占比',
  field_redactSecrets: '提取时脱敏密钥',
  hint_workspaceDir: '留空使用 ~/.dsh-memory/memories',
  hint_dbPath: '留空使用 ~/.dsh-memory/memories.sqlite',
  hint_extractModel: '留空使用默认模型',
  hint_consolidationModel: '留空使用默认模型',
  hint_extractInputContextRatio: '0.1 – 0.95',
  hint_consolidatorDenyPatterns: '整理器默认只开放 read/write/edit/glob/grep;这里的正则在白名单之上再拒绝',
  overridden: '已覆盖',
  reset: '重置',
  save: '保存',
  discard: '放弃',
  saving: '保存中…',
  failed: '保存失败',
  invalid: '存在无效输入',
  readOnly: '此文档不可写',
  statusIdle: '空闲',
  modelDefault: '跟随默认模型',
  catalogRefresh: '刷新模型目录',
  catalogLoading: '模型目录加载中…',
  catalogError: '模型目录加载失败,可重试或直接填写 provider/model',
  done: '记忆已更新',
  minimize: '最小化',
  menuExpand: '展开',
  pausedBadge: '已暂停',
  menuRunNow: '立即整理一次',
  menuViewMemory: '查看记忆',
  menuPause: '暂停自动调度',
  menuResume: '恢复自动调度',
  menuOpenFolder: '打开记忆文件夹',
  phase1: '记忆提取中',
  phase2: '记忆整理中',
  processing: '记忆处理中',
  transfer_hint: '导出生成单个 gzip 压缩的 bundle 文件;导入按内容哈希去重合并,冲突以本地为准,未压缩的 JSON 也能读。',
  transfer_exportPath: '导出到文件',
  transfer_importPath: '从文件导入',
  transfer_export: '导出',
  transfer_import: '导入',
  transfer_requested: '已发送,结果见上方状态栏',
  viewer_title: '记忆浏览',
  viewer_refresh: '刷新',
  viewer_translate: '翻译记忆',
  viewer_translating: '翻译中…',
  viewer_tab_overview: '概览',
  viewer_tab_summary: '摘要',
  viewer_tab_index: '注册表',
  viewer_tab_records: '记录',
  viewer_stat_records: '记忆记录',
  viewer_stat_consolidated: '已整理',
  viewer_stat_citations: '被引用次数',
  viewer_stat_summarySize: '摘要大小',
  viewer_original: '显示原文',
  viewer_translated: '显示译文',
  viewer_showTranslated: '显示译文',
  viewer_badgeTranslated: '译文',
  viewer_rebuild: '重建译文',
  viewer_rebuildConfirm: '忽略缓存全文重翻?',
  viewer_confirm: '确认',
  viewer_cancel: '取消',
  viewer_retranslate: '重新翻译',
  viewer_stale: '译文已过期',
  viewer_fresh: '译文为最新',
  viewer_empty: '暂无内容',
  viewer_decodeFailed: '记忆内容解码失败(浏览器不支持 DecompressionStream)',
  viewer_search: '搜索会话 / 路径…',
  viewer_col_session: '会话',
  viewer_col_usage: '引用',
  viewer_col_updated: '更新时间',
  viewer_col_lastUsed: '最近引用',
}

const EN: Record<string, string> = {
  nav: 'Memory',
  title: 'Memory',
  intro: 'Idle sessions are extracted automatically, consolidated into a searchable file-based memory library, and recalled on demand.',
  unavailable: 'Memory settings are unavailable in this deployment (namespace not served).',
  group_general: 'General',
  group_models: 'Models',
  group_schedule: 'Scheduling & retention',
  group_recall: 'Recall injection',
  group_transfer: 'Import / Export',
  group_advanced: 'Advanced',
  field_enabled: 'Enable memory system',
  field_generateMemories: 'Generate memories automatically',
  field_useMemories: 'Inject memory summary',
  field_workspaceDir: 'Memory workspace directory',
  field_dbPath: 'SQLite database path',
  field_extractModel: 'Extraction model (provider/model)',
  field_consolidationModel: 'Consolidation model (provider/model)',
  field_scanIntervalMinutes: 'Scan interval (minutes)',
  field_minRolloutIdleHours: 'Session idle threshold (hours)',
  field_maxSessionAgeDays: 'Max session age (days)',
  field_maxUnusedDays: 'Unused memory retention (days)',
  field_maxRolloutSummaries: 'Rollout summary cap',
  field_phase2SuccessCooldownSeconds: 'Consolidation cooldown (seconds)',
  field_phase2TimeoutMinutes: 'Consolidation timeout (minutes)',
  field_phase1RetryBackoffMinutes: 'Extraction retry backoff (minutes)',
  field_phase1MaxRetries: 'Extraction retries',
  field_phase1MaxPerCycle: 'Extractions per cycle',
  field_phase1MaxConcurrency: 'Extraction concurrency',
  field_consolidatorDenyPatterns: 'Extra consolidator tool denies (regex)',
  field_summaryTokenLimit: 'Summary injection token cap',
  field_extractInputContextRatio: 'Extraction context ratio',
  field_redactSecrets: 'Redact secrets during extraction',
  hint_workspaceDir: 'Empty = ~/.dsh-memory/memories',
  hint_dbPath: 'Empty = ~/.dsh-memory/memories.sqlite',
  hint_extractModel: 'Empty = deployment default model',
  hint_consolidationModel: 'Empty = deployment default model',
  hint_extractInputContextRatio: '0.1 – 0.95',
  hint_consolidatorDenyPatterns: 'The consolidator only gets read/write/edit/glob/grep; these regexes deny more on top of the whitelist',
  overridden: 'overridden',
  reset: 'reset',
  save: 'Save',
  discard: 'Discard',
  saving: 'Saving…',
  failed: 'Save failed',
  invalid: 'Invalid input',
  readOnly: 'This document is read-only',
  statusIdle: 'Idle',
  modelDefault: 'Follow default model',
  catalogRefresh: 'Refresh models',
  catalogLoading: 'Loading model catalog…',
  catalogError: 'Model catalog failed to load — retry or type provider/model directly',
  done: 'Memory updated',
  minimize: 'Minimize',
  menuExpand: 'Expand',
  pausedBadge: 'Paused',
  menuRunNow: 'Run now',
  menuViewMemory: 'View memories',
  menuPause: 'Pause scheduling',
  menuResume: 'Resume scheduling',
  menuOpenFolder: 'Open memory folder',
  phase1: 'Extracting memories',
  phase2: 'Consolidating memories',
  processing: 'Memory processing',
  transfer_hint: 'Export writes one gzip-compressed bundle file; import merges by content hash (conflicts keep the local copy) and also accepts uncompressed JSON.',
  transfer_exportPath: 'Export to file',
  transfer_importPath: 'Import from file',
  transfer_export: 'Export',
  transfer_import: 'Import',
  transfer_requested: 'Sent — result appears in the status bar above',
  viewer_title: 'Memory',
  viewer_refresh: 'Refresh',
  viewer_translate: 'Translate memory',
  viewer_translating: 'Translating…',
  viewer_tab_overview: 'Overview',
  viewer_tab_summary: 'Summary',
  viewer_tab_index: 'Registry',
  viewer_tab_records: 'Records',
  viewer_stat_records: 'Records',
  viewer_stat_consolidated: 'Consolidated',
  viewer_stat_citations: 'Citations',
  viewer_stat_summarySize: 'Summary size',
  viewer_original: 'Show original',
  viewer_translated: 'Show translation',
  viewer_showTranslated: 'Translation',
  viewer_badgeTranslated: 'Translated',
  viewer_rebuild: 'Rebuild',
  viewer_rebuildConfirm: 'Ignore cache and retranslate everything?',
  viewer_confirm: 'Confirm',
  viewer_cancel: 'Cancel',
  viewer_retranslate: 'Re-translate',
  viewer_stale: 'Translation stale',
  viewer_fresh: 'Up to date',
  viewer_empty: 'Nothing here yet',
  viewer_decodeFailed: 'Could not decode memory content (browser lacks DecompressionStream)',
  viewer_search: 'Search sessions or paths…',
  viewer_col_session: 'Session',
  viewer_col_usage: 'Citations',
  viewer_col_updated: 'Updated',
  viewer_col_lastUsed: 'Last used',
}

/** Activate the browser half: register the Memory settings page and the status pill. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dsh-memory: dictionaries')
  // Keep the raw citation XML out of the visible transcript (the host-side
  // citation loop reads it from the session log regardless).
  ctx.effect(() => installCitationStripper(), 'dsh-memory: citation stripper')

  const cardScope = ctx.settingsScope.bind({ namespace: 'memory' })
  const statusScope = ctx.settingsScope.bind({ namespace: 'memory-status' })
  const commandsScope = ctx.settingsScope.bind({ namespace: 'memory-commands' })
  const viewerScope = ctx.settingsScope.bind({ namespace: 'memory-view' })
  const card = new MemoryCardController(cardScope, catalogLoader(ctx))
  // Bound closures: detached scope methods may rely on `this`.
  const statusSource = {
    getSnapshot: () => statusScope.getSnapshot(),
    subscribe: (listener: () => void) => statusScope.subscribe(listener),
  }
  const viewSource = {
    getSnapshot: () => viewerScope.getSnapshot(),
    subscribe: (listener: () => void) => viewerScope.subscribe(listener),
  }
  const commandsView = {
    set: (field: string, value: unknown) => commandsScope.set(field, value),
    unset: (field: string) => commandsScope.unset(field),
  }
  const memoryView = {
    set: (field: string, value: unknown) => cardScope.set(field, value),
    unset: (field: string) => cardScope.unset(field),
    getSnapshot: () => cardScope.getSnapshot(),
    subscribe: (listener: () => void) => cardScope.subscribe(listener),
  }

  // Standalone viewer page: a right-sidebar tab (ui-sidebar-right is optional
  // in the composition, so the whole registration waits on the service).
  let sidebarRight: ClientContext['sidebarRight']
  ctx.inject(['sidebarRightTabs', 'sidebarRight'], (sctx) => {
    sidebarRight = sctx.sidebarRight
    const tabTitle = (): string => ctx.locale.bind(NS)('viewer_title')
    sctx.effect(() => sctx.sidebarRightTabs?.register({
      id: MEMORY_VIEWER_ID,
      kind: MEMORY_VIEWER_KIND,
      title: tabTitle,
    }), 'dsh-memory: viewer tab type')
    sctx.effect(() => sctx.slots.inject('sidebar.right.pane.tab', () => sctx.slots.register(
      {
        name: 'sidebar.right.pane.tab',
        key: MEMORY_VIEWER_ID,
        locale: NS,
        inject: () => ({
          hooks: { memoryView: viewSource, memoryStatus: statusSource },
          commands: commandsView,
        }),
      },
      MemoryViewerBody,
    )), 'dsh-memory: viewer tab body')
    sctx.effect(() => sctx.slots.inject('sidebar.right.pane.tab.title', () => sctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: MEMORY_VIEWER_ID, locale: NS },
      MemoryViewerTitle,
    )), 'dsh-memory: viewer tab title')
  })
  const openViewer = (): void => {
    try {
      sidebarRight?.openTab(MEMORY_VIEWER_KIND, {})
    } catch {
      // the pane can fail to open only when the sidebar service is gone
    }
  }
  // Own Settings → Memory page (independent section in the settings sidebar).
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'memory',
      order: 16,
      label: () => t_nav(ctx),
      locale: NS,
      inject: () => ({
        // The controller face carries edit/resetField/refreshCatalog; the
        // renderer binds them as plain props, and the hooks compartment as
        // useMemoryPage/useMemoryStatus selector hooks.
        ...card.inject(),
        commands: commandsView,
        hooks: {
          memoryPage: card.pageStore(),
          memoryStatus: statusSource,
        },
      }),
    },
    MemorySettingsPage,
  ))

  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    {
      name: 'sidebar.footer.action',
      id: 'dsh-memory-status',
      order: 10,
      locale: NS,
      inject: () => ({
        hooks: { memoryStatus: statusSource },
        commands: commandsView,
        settings: memoryView,
        openViewer,
      }),
    },
    MemoryFooterAction,
  ))
}

function t_nav(ctx: ClientContext): string {
  const t = ctx.locale.bind(NS)
  return t('nav')
}

/** Query the Host model catalog and flatten it into selectable routes. */
function catalogLoader(ctx: ClientContext): (() => Promise<CatalogModel[]>) | null {
  const call = ctx.remote?.session?.modelCatalog
  if (call == null) return null
  return async (): Promise<CatalogModel[]> => {
    const result = await call.call(ctx.remote!.session!)
    if (!result?.ok || result.value == null) {
      throw new Error('model catalog unavailable')
    }
    const catalog = result.value as {
      groups: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>
    }
    return catalog.groups.flatMap((group) => group.models.map((model) => ({
      provider: group.id,
      providerName: group.name,
      model: model.id,
      modelName: model.name,
    })))
  }
}
