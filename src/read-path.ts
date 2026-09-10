import path from 'node:path'

import type { DshContext } from './dsh-types.ts'
import type { MemoryPaths } from './paths.ts'
import type { MemoryPluginConfig } from './config.ts'
import { displayPath } from './paths.ts'
import { readTextFileOrNull } from './workspace.ts'
import { truncateHeadTokens } from './transcript.ts'
import { currentTranslation } from './view.ts'

const CONTEXT_NAME = 'dsh-memory-summary'
/** Late in the runtime-context ordering; repo-owned placements use lower numbers. */
const CONTEXT_ORDER = 5000

/** Render the "## Memory" reminder injected ahead of every assembly. */
export function renderMemoryReadPathReminder(root: string, memorySummary: string): string {
  const base = displayPath(root)
  return `## Memory

You have access to a local dsh memory folder with guidance from prior runs. Use it when it is likely to help with the current request.

Decision boundary:
- Skip memory only when the request is clearly self-contained and does not need workspace history, prior decisions, or user preferences.
- Use memory when the request mentions this repo, paths, modules, prior work, prior decisions, or a non-trivial task related to the memory summary below.
- If unsure, do a quick memory pass.

Memory layout:
- ${base}/memory_summary.md is already provided below; do not read it again.
- ${base}/MEMORY.md is the searchable registry and the primary file to inspect for deeper context.
- ${base}/rollout_summaries/ contains per-rollout evidence snippets referenced by MEMORY.md.
- ${base}/extensions/ad_hoc/notes/ is where user-requested memory updates should be written.

Quick memory pass:
1. Skim MEMORY_SUMMARY below and extract task-relevant keywords.
2. Search ${base}/MEMORY.md for those keywords.
3. Only if MEMORY.md points to relevant evidence, read the 1-2 matching files under ${base}/rollout_summaries/.
4. If there are no relevant hits, stop memory lookup and continue normally.

Tool access:
- When deeper memory lookup is needed, use the normal local file/search tools available in this session, such as read, grep, or glob, against the memory folder above.
- The memory folder path above is an authorized local memory root for this read path. Do not use it to inspect unrelated user files.
- If file/search tools are unavailable, rely only on MEMORY_SUMMARY and say when a useful deeper lookup could not be performed.

Memory citation requirements:
- If any memory files beyond the injected MEMORY_SUMMARY were used, append exactly one <dsh-mem-citation> block as the very last content of the final reply.
- Use this structure:
<dsh-mem-citation>
<citation_entries>
MEMORY.md:10-12|note=[short reason]
rollout_summaries/example.md:3-4|note=[short reason]
</citation_entries>
<rollout_ids>
rollout-or-session-id
</rollout_ids>
</dsh-mem-citation>
- citation_entries paths must be relative to the memory root.
- Use tight, non-blank line ranges.
- Include rollout_ids only when the referenced memory file exposes stable rollout or session ids.
- Do not include memory citations inside pull-request messages or other user-requested generated artifacts.

Updating memories:
- Write ad hoc memory notes only when the user explicitly asks to update, save, or remember memory.
- Write one small note under ${base}/extensions/ad_hoc/notes/.
- Name it YYYY-MM-DDTHH-MM-SS-<short-slug>.md using only lowercase ASCII letters, digits, and hyphens in the slug.
- Use the normal write tool for this exact path when an ad hoc note is needed.
- Do not edit MEMORY.md or memory_summary.md directly for ad hoc updates.

========= MEMORY_SUMMARY BEGINS =========
${memorySummary.trim()}
========= MEMORY_SUMMARY ENDS =========

When memory is likely relevant, start with the quick memory pass before deeper repo exploration.`
}

/** Build the reminder text, or '' when memory must not be injected this turn. */
export function buildMemoryReadPathText(paths: MemoryPaths, config: MemoryPluginConfig): string {
  if (!config.enabled || !config.useMemories) return ''
  const root = paths.workspaceRoot
  const summary = readTextFileOrNull(path.join(root, 'memory_summary.md'))?.trim() ?? ''
  if (summary === '') return ''
  // A translated copy wins when its sidecar hash still matches the source
  // (a consolidation rewrite instantly stale-ifies it back to English).
  const translation = currentTranslation(root)
  const effective = translation.stale || translation.text === '' ? summary : translation.text
  const truncated = truncateHeadTokens(effective, config.summaryTokenLimit)
  return renderMemoryReadPathReminder(root, truncated)
}

/** Register the read path: a dynamic prompt context evaluated per assembly. */
export function registerReadPath(ctx: DshContext, paths: MemoryPaths, config: MemoryPluginConfig): void {
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: () => buildMemoryReadPathText(paths, config),
  })
}
