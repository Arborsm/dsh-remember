/**
 * Render a persisted dsh session log into the Phase 1 extraction transcript:
 * per-part token caps, middle truncation with explicit markers, secret
 * redaction, and a JSON message list of user / assistant(+tool_calls) / tool
 * roles.
 */

import type { SessionEvent } from './dsh-types.ts'

const APPROX_BYTES_PER_TOKEN = 4
const MESSAGE_CONTENT_TOKEN_LIMIT = 8_000
const TOOL_INPUT_TOKEN_LIMIT = 6_000
const TOOL_RESULT_TOKEN_LIMIT = 12_000
const TOOL_ERROR_TOKEN_LIMIT = 1_000

export interface TranscriptToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type TranscriptMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; tool_calls?: TranscriptToolCall[] }
  | { role: 'tool'; name: string; tool_call_id: string; content: string }

export function approxTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / APPROX_BYTES_PER_TOKEN)
}

function tokensFromBytes(bytes: number): number {
  return Math.ceil(bytes / APPROX_BYTES_PER_TOKEN)
}

function previousCharBoundary(text: string, maxBytes: number): number {
  if (maxBytes >= Buffer.byteLength(text, 'utf8')) return text.length
  let index = Math.min(maxBytes, text.length)
  while (index > 0 && (text.charCodeAt(index) & 0xc0) === 0x80) index -= 1
  return index
}

function truncateMiddleBytes(text: string, byteLimit: number): string {
  const marker = `…${tokensFromBytes(Math.max(0, Buffer.byteLength(text, 'utf8') - byteLimit))} tokens truncated…`
  if (byteLimit <= Buffer.byteLength(marker, 'utf8')) return marker
  const contentBudget = byteLimit - Buffer.byteLength(marker, 'utf8')
  const headBudget = Math.floor(contentBudget / 2)
  const tailBudget = contentBudget - headBudget
  const bytes = Buffer.from(text, 'utf8')
  const headEnd = previousCharBoundary(text, headBudget)
  const tailStartBytes = Math.max(0, bytes.length - tailBudget)
  let tailStart = tailStartBytes
  while (tailStart < text.length && (text.charCodeAt(tailStart) & 0xc0) === 0x80) tailStart += 1
  return `${text.slice(0, headEnd)}${marker}${text.slice(tailStart)}`
}

export function truncateMiddleTokens(text: string, tokenLimit: number): string {
  if (text === '') return ''
  const byteLimit = tokenLimit * APPROX_BYTES_PER_TOKEN
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text
  return truncateMiddleBytes(text, byteLimit)
}

export function truncateHeadTokens(text: string, tokenLimit: number): string {
  if (text === '') return ''
  const byteLimit = tokenLimit * APPROX_BYTES_PER_TOKEN
  if (Buffer.byteLength(text, 'utf8') <= byteLimit) return text
  const bytes = Buffer.byteLength(text, 'utf8')
  let end = byteLimit
  while (end > 0 && (text.charCodeAt(end) & 0xc0) === 0x80) end -= 1
  return `${text.slice(0, end)}\n\n[Memory summary truncated: approximately ${tokensFromBytes(bytes - end)} tokens omitted]`
}

// ── secret redaction ────────────────────────────────────────────────────────

const REDACTION_RULES: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gu, replacement: 'Bearer [REDACTED]' },
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/gu, replacement: '[REDACTED_OPENAI_KEY]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu, replacement: '[REDACTED_GITHUB_TOKEN]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/gu, replacement: '[REDACTED_AWS_ACCESS_KEY]' },
  {
    // Rust source used an inline (?i); JavaScript expresses it as the `i` flag.
    pattern: /(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|password|secret|token)(\s*[:=]\s*)(")?[^"',\s\\}\[]{6,}(")?/giu,
    replacement: '$1$2$3[REDACTED]$4',
  },
]

export function redactSecrets(text: string): string {
  let redacted = text
  for (const { pattern, replacement } of REDACTION_RULES) {
    redacted = redacted.replace(pattern, replacement)
  }
  return redacted
}

// ── event folding ───────────────────────────────────────────────────────────

function stripReminderBlocks(text: string): string {
  return text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/giu, '')
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/giu, '')
    .trim()
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block == null || typeof block !== 'object') continue
    const typed = block as { type?: string; text?: string }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
    if (typed.type === 'image' || typed.type === 'file') parts.push(`[${typed.type} omitted]`)
  }
  return parts.join('\n\n')
}

function truncateJsonArgs(raw: string): string {
  if (approxTokenCount(raw) <= TOOL_INPUT_TOKEN_LIMIT) return raw
  return JSON.stringify({
    truncated: true,
    preview: truncateMiddleTokens(raw, TOOL_INPUT_TOKEN_LIMIT),
  })
}

/**
 * Fold session events into the extraction transcript. The current surface is
 * reconstructed from the log: user/assistant/tool messages in model-visible
 * order, with injected plugin contexts and boundary markers skipped.
 */
export function renderMemoryTranscript(events: SessionEvent[], tokenLimit: number, redact = true): string {
  const toolNames = new Map<string, string>()
  for (const event of events) {
    if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
    }
  }

  const messages: TranscriptMessage[] = []
  for (const event of events) {
    if (event.type === 'user/message') {
      const source = event.data.source as { kind?: string } | undefined
      if (source?.kind === 'plugin') continue
      const content = stripReminderBlocks(textOfContent(event.data.content))
      if (content === '') continue
      messages.push({ role: 'user', content: truncateMiddleTokens(content, MESSAGE_CONTENT_TOKEN_LIMIT) })
      continue
    }
    if (event.type === 'assistant/message') {
      const blocks = event.data.message?.content
      const content = textOfContent(blocks)
      const toolCalls: TranscriptToolCall[] = Array.isArray(blocks)
        ? blocks
          .filter((block): block is { type: 'tool-call'; id: string; name: string; arguments: string } =>
            block != null && typeof block === 'object' && (block as { type?: string }).type === 'tool-call')
          .map((block) => ({
            id: block.id,
            type: 'function' as const,
            function: {
              name: block.name,
              arguments: truncateJsonArgs(block.arguments ?? '{}'),
            },
          }))
        : []
      const trimmed = truncateMiddleTokens(content.trim(), MESSAGE_CONTENT_TOKEN_LIMIT)
      if (trimmed !== '' || toolCalls.length > 0) {
        messages.push(toolCalls.length > 0
          ? { role: 'assistant', content: trimmed, tool_calls: toolCalls }
          : { role: 'assistant', content: trimmed })
      }
      continue
    }
    if (event.type === 'tool/result') {
      const blocks = event.data.message?.content ?? []
      const toolBlock = blocks.find((block) => block?.type === 'tool-result')
      const callId = toolBlock?.toolCallId ?? ''
      const name = toolNames.get(callId) ?? 'tool'
      const isError = toolBlock?.isError === true
      const content = textOfContent(toolBlock?.content)
      const body = isError && content !== ''
        ? `Tool failed: ${truncateMiddleTokens(content, TOOL_ERROR_TOKEN_LIMIT)}`
        : truncateMiddleTokens(content, TOOL_RESULT_TOKEN_LIMIT)
      messages.push({
        role: 'tool',
        name,
        tool_call_id: callId,
        content: body,
      })
    }
  }

  if (messages.length === 0) return ''
  const json = JSON.stringify(messages)
  return truncateMiddleTokens(redact ? redactSecrets(json) : json, tokenLimit)
}
