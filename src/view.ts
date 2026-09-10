import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { MemoryDatabase } from './db.ts'
import type { DshContext } from './dsh-types.ts'
import type { MemoryPaths } from './paths.ts'
import type { MemoryPluginConfig } from './config.ts'
import type { ViewWriter } from './settings.ts'
import { resolveModelConfig, oneShot, offReasoningEffort } from './llm.ts'
import { readTextFileOrNull, writeTextFileIfChanged } from './workspace.ts'

/** The artifacts the viewer can translate, with their sources. */
const ARTIFACTS = [
  { key: 'summary', source: 'memory_summary.md', base: 'memory_summary' },
  { key: 'index', source: 'MEMORY.md', base: 'MEMORY' },
] as const

type ArtifactKey = typeof ARTIFACTS[number]['key']

const TRANSLATION_META_NAME = 'memory-translation.meta.json'

/** Language tags a translation file can carry. */
const LANG_TAGS = ['zh', 'en'] as const
type LangTag = typeof LANG_TAGS[number]

interface TranslationMeta {
  sourceHash: string
  lang: string
  at: number
}

type TranslationMetaFile = Partial<Record<ArtifactKey, TranslationMeta>>

/** Normalize a requested language to a file tag (`zh` / `en`). */
function langTag(lang: string): LangTag {
  return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

/** `memory_summary.zh.md` / `MEMORY.en.md` — the tag keeps the name honest. */
function targetName(artifact: typeof ARTIFACTS[number], tag: string): string {
  return `${artifact.base}.${tag}.md`
}

export function sourceHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function readMeta(root: string): TranslationMetaFile {
  const raw = readTextFileOrNull(path.join(root, TRANSLATION_META_NAME))
  if (raw == null) return {}
  try {
    const parsed = JSON.parse(raw) as TranslationMetaFile
    return typeof parsed === 'object' && parsed !== null ? parsed : {}
  } catch {
    return {}
  }
}

function writeMeta(root: string, meta: TranslationMetaFile): void {
  const file = path.join(root, TRANSLATION_META_NAME)
  const next = JSON.stringify(meta)
  if (readTextFileOrNull(file) === next) return
  fs.writeFileSync(file, next, 'utf8')
}

function readSource(root: string, name: string): string {
  return readTextFileOrNull(path.join(root, name))?.trim() ?? ''
}

/** Delete every translation file of one artifact except `keep`, plus their meta entries. */
function pruneArtifactTranslations(
  root: string,
  meta: TranslationMetaFile,
  artifact: typeof ARTIFACTS[number],
  keep?: string,
): boolean {
  let changed = false
  for (const tag of LANG_TAGS) {
    const name = targetName(artifact, tag)
    if (name === keep) continue
    const file = path.join(root, name)
    if (fs.existsSync(file)) {
      fs.rmSync(file, { force: true })
      changed = true
    }
  }
  const entry = meta[artifact.key]
  if (entry != null && (keep == null || targetName(artifact, entry.lang) !== keep)) {
    delete meta[artifact.key]
    changed = true
  }
  return changed
}

/**
 * A translation counts as current only when its sidecar hash matches the live
 * source: a Phase 2 consolidation rewrites the artifacts and instantly
 * stale-ifies everything translated before it.
 */
export function currentTranslations(root: string): { summary: string; index: string; stale: boolean } {
  const meta = readMeta(root)
  let stale = false
  const texts: Record<'summary' | 'index', string> = { summary: '', index: '' }
  for (const artifact of ARTIFACTS) {
    const source = readSource(root, artifact.source)
    const entry = meta[artifact.key]
    const file = entry == null ? '' : readTextFileOrNull(path.join(root, targetName(artifact, entry.lang)))?.trim() ?? ''
    if (file === '') continue
    if (entry == null || entry.sourceHash !== sourceHash(source)) {
      stale = true
      continue
    }
    texts[artifact.key] = file
  }
  return { ...texts, stale }
}

/** The translated summary when it is current; used by the read path. */
export function currentTranslation(root: string): { text: string; stale: boolean } {
  const { summary, stale } = currentTranslations(root)
  return { text: summary, stale }
}

/** Mirror the memory workspace into the viewer namespace. */
export function publishMemoryView(db: MemoryDatabase, paths: MemoryPaths, write: ViewWriter): void {
  const root = paths.workspaceRoot
  const translated = currentTranslations(root)
  write({
    summary: readSource(root, 'memory_summary.md'),
    index: readSource(root, 'MEMORY.md'),
    translatedSummary: translated.summary,
    translatedIndex: translated.index,
    translatedStale: translated.stale,
    records: JSON.stringify(db.listStage1Stats()),
  })
}

const TRANSLATE_MAX_TOKENS = 8_000
/** Target segment size: enough context for a faithful translation, small enough to localize an edit. */
const SEGMENT_CHARS = 1_000
/** Parallel translation requests; segments are independent of each other. */
const TRANSLATE_CONCURRENCY = 3

/**
 * Translate the memory artifacts (summary + registry) through a segment-level
 * translation memory: the source is cut into line-aligned segments, each one
 * cached in SQLite by content hash. An edit therefore re-translates only the
 * segment it touched, and identical segments are translated once.
 */
export async function translateMemory(
  ctx: DshContext,
  db: MemoryDatabase,
  paths: MemoryPaths,
  config: MemoryPluginConfig,
  lang: string,
  options: { force?: boolean; onProgress?: (progress: { done: number; total: number }) => void } = {},
): Promise<{ translated: ArtifactKey[]; cached: ArtifactKey[] }> {
  const { force = false, onProgress } = options
  const root = paths.workspaceRoot
  const meta = readMeta(root)
  const model = resolveModelConfig(config.consolidationModel, ctx.agentDefaultModel.currentSelection())
  const tag = langTag(lang)
  const target = tag === 'zh' ? 'Simplified Chinese (简体中文)' : 'English'
  // Translation is mechanical: an enabled thinking phase bills against
  // maxTokens and can starve the answer entirely (observed: empty output).
  const reasoningEffort = await offReasoningEffort(ctx.llm, model)
  const translated: ArtifactKey[] = []
  const cached: ArtifactKey[] = []

  // Plan every artifact: segment it, then look the whole file up in the TM.
  interface Plan { artifact: typeof ARTIFACTS[number]; source: string; segments: string[]; hashes: string[] }
  const plans: Plan[] = []
  const pending = new Map<string, { hash: string; source: string }>()

  for (const artifact of ARTIFACTS) {
    const source = readSource(root, artifact.source)
    if (source === '') {
      // Source gone: drop its translation instead of leaving an orphan.
      if (pruneArtifactTranslations(root, meta, artifact)) writeMeta(root, meta)
      continue
    }
    const segments = splitSegments(source)
    const hashes = segments.map((segment) => sourceHash(segment))
    plans.push({ artifact, source, segments, hashes })
    const known = force ? new Map<string, string>() : db.getTranslationSegments(tag, hashes)
    hashes.forEach((hash, index) => {
      if (!known.has(hash) && !pending.has(hash)) pending.set(hash, { hash, source: segments[index] as string })
    })
  }

  // One request per distinct missing segment, through a small parallel pool.
  const tasks = [...pending.values()]
  const total = tasks.length
  let done = 0
  let cursor = 0
  const fresh = new Map<string, string>()
  const worker = async (): Promise<void> => {
    while (cursor < tasks.length) {
      const task = tasks[cursor] as { hash: string; source: string }
      cursor += 1
      const text = await translateSegment(
        ctx, model, task.source, target, task.hash.slice(0, 8), reasoningEffort,
      )
      fresh.set(task.hash, text)
      done += 1
      onProgress?.({ done, total })
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(TRANSLATE_CONCURRENCY, tasks.length) }, () => worker()),
  )

  for (const plan of plans) {
    const { artifact, source, segments, hashes } = plan
    const known = force ? new Map<string, string>() : db.getTranslationSegments(tag, hashes)
    const parts = segments.map((segment, index) => {
      const hash = hashes[index] as string
      return known.get(hash) ?? fresh.get(hash) ?? segment
    })
    const name = targetName(artifact, tag)
    const changed = plan.hashes.some((hash) => fresh.has(hash))
    const written = writeTextFileIfChanged(path.join(root, name), `${parts.join('\n')}\n`)
    // Keep exactly one language per artifact.
    pruneArtifactTranslations(root, meta, artifact, name)
    if (changed || written) {
      meta[artifact.key] = { sourceHash: sourceHash(source), lang: tag, at: Date.now() }
      translated.push(artifact.key)
    } else {
      cached.push(artifact.key)
    }
  }

  if (fresh.size > 0 || plans.length > 0) {
    db.putTranslationSegments(
      tag,
      [...fresh].map(([hash, text]) => ({ hash, source: pending.get(hash)?.source ?? '', translated: text })),
      plans.flatMap((plan) => plan.hashes),
    )
  }
  writeMeta(root, meta)

  if (translated.length === 0 && cached.length === 0) {
    throw new Error('nothing to translate (memory artifacts are empty)')
  }
  return { translated, cached }
}

async function translateSegment(
  ctx: DshContext,
  model: { provider: string; model: string },
  segment: string,
  target: string,
  label: string,
  reasoningEffort: string | undefined,
): Promise<string> {
  const result = await oneShot(ctx.llm, {
    provider: model.provider,
    model: model.model,
    system: [
      `Translate the markdown memory fragment below into ${target}.`,
      'Rules: preserve the markdown structure, headings, lists, code spans, file paths and tags like [ad-hoc note];',
      'keep a leading `v1` line as `v1`. Translate prose only, never invent or drop content.',
      'Output the translated fragment and nothing else.',
    ].join('\n'),
    messages: [{
      id: `dsh-memory-translate-${label}-${Date.now()}`,
      role: 'user',
      content: [{ type: 'text', text: segment }],
      source: { kind: 'plugin', plugin: 'dsh-memory-plugin' },
    }],
    maxTokens: TRANSLATE_MAX_TOKENS,
    reasoningEffort,
    signal: undefined,
  })
  const text = result.text.trim()
  if (text === '') {
    const usage = result.usage == null ? 'no usage' : `out=${result.usage.outputTokens}`
    throw new Error(
      `translator returned empty output for ${label}`
        + ` (finish=${result.finishKind}, ${usage}, reasoning=${result.reasoningChars} chars)`,
    )
  }
  return text
}

/**
 * Cut source into line-aligned segments at headings and size limits;
 * `splitSegments(text).join('\n') === text` holds, so reassembly is lossless.
 */
function splitSegments(text: string, limit = SEGMENT_CHARS): string[] {
  const segments: string[] = []
  let current: string[] = []
  let size = 0
  for (const line of text.split('\n')) {
    const heading = /^#{1,6}\s/.test(line)
    if (current.length > 0 && (size + line.length + 1 > limit || heading)) {
      segments.push(current.join('\n'))
      current = []
      size = 0
    }
    current.push(line)
    size += line.length + 1
  }
  if (current.length > 0) segments.push(current.join('\n'))
  return segments
}
