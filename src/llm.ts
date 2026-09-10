import type { GenerateOptions, LlmModelSelection, LlmRuntime, StreamChunk } from './dsh-types.ts'
import { approxTokenCount } from './transcript.ts'

export interface ResolvedModel {
  provider: string
  model: string
}

/**
 * Resolve `provider/model` config strings; an empty value falls back to the
 * deployment's default model selection.
 */
export function resolveModelConfig(spec: string | undefined, fallback: LlmModelSelection): ResolvedModel {
  const trimmed = spec?.trim() ?? ''
  if (trimmed !== '') {
    const slash = trimmed.indexOf('/')
    if (slash > 0) {
      return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) }
    }
    if (fallback.provider && fallback.model) {
      return { provider: fallback.provider, model: trimmed }
    }
  }
  if (!fallback.provider || !fallback.model) {
    throw new Error('no model configured: set extractModel/consolidationModel or a default model selection')
  }
  return { provider: fallback.provider, model: fallback.model }
}

export interface OneShotResult {
  text: string
  usage: { inputTokens: number; outputTokens: number } | null
  /** Stream finish kind ('stop' | 'max-tokens' | 'tool-calls' | ...). */
  finishKind: string
  /** Reasoning characters seen before the answer (diagnoses budget starvation). */
  reasoningChars: number
}

/** Fold the raw chunk stream into plain text (no BlockAssembler needed). */
function foldText(chunks: StreamChunk[]): string {
  const parts: string[] = []
  for (const chunk of chunks) {
    if (chunk.type === 'text-delta') parts.push(chunk.text)
  }
  return parts.join('')
}

/**
 * One-shot system+user model call used by Phase 1 extraction. Adapters stay in
 * control of retries at the harness layer; this helper performs exactly one
 * dispatch of the fully assembled request.
 */
export async function oneShot(llm: LlmRuntime, options: GenerateOptions): Promise<OneShotResult> {
  const chunks: StreamChunk[] = []
  let usage: OneShotResult['usage'] = null
  let finishKind = 'unknown'
  let reasoningChars = 0
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'usage') {
      usage = { inputTokens: chunk.usage.inputTokens, outputTokens: chunk.usage.outputTokens }
      continue
    }
    if (chunk.type === 'finish') {
      finishKind = chunk.reason.kind
      if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') {
        const failure = chunk.reason.failure
        const detail = failure == null
          ? ''
          : `: ${[failure.code, failure.message].filter((part) => part != null && part !== '').join(' — ')}`
        throw new Error(`model request finished with ${chunk.reason.kind}${detail}`)
      }
      continue
    }
    if (chunk.type === 'reasoning-delta') {
      reasoningChars += chunk.text.length
      continue
    }
    chunks.push(chunk)
  }
  return { text: foldText(chunks), usage, finishKind, reasoningChars }
}

/**
 * 'off' when the model offers that reasoning effort, else undefined. Mechanical
 * plugin tasks (translation) must not reason: a thinking phase bills against
 * maxTokens and can leave the answer empty.
 */
export async function offReasoningEffort(llm: LlmRuntime, model: ResolvedModel): Promise<string | undefined> {
  try {
    const info = await llm.resolveModelInfo(model.provider, model.model)
    const efforts = (info as { reasoning?: { efforts?: Array<{ id: unknown }> } } | undefined)?.reasoning?.efforts
    return efforts?.some((effort) => String(effort.id) === 'off') === true ? 'off' : undefined
  } catch {
    return undefined
  }
}

/**
 * Transcript token budget for one extraction call: the configured fraction of
 * the model context window minus the system prompt and output reserve.
 */
export async function transcriptTokenLimit(
  llm: LlmRuntime,
  model: ResolvedModel,
  systemPrompt: string,
  ratio: number,
  outputReserveTokens: number,
): Promise<number> {
  let contextWindow = 128_000
  try {
    const info = await llm.resolveModelInfo(model.provider, model.model)
    if (info?.context?.contextWindow && info.context.contextWindow > 0) {
      contextWindow = info.context.contextWindow
    }
  } catch {
    // Advisory metadata only; the default keeps a conservative budget.
  }
  const usable = Math.floor(contextWindow * ratio)
  const system = approxTokenCount(systemPrompt)
  return Math.max(2_000, usable - system - outputReserveTokens)
}
