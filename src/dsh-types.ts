/**
 * Structural typings for the dsh services this plugin consumes. These mirror
 * the documented surfaces (docs/subsystems/*) without importing dsh packages
 * at runtime — the host passes the live services in through cordis injection.
 */

/** Minimal cordis Context face used by this plugin (registrations auto-clean). */
export interface CordisContext {
  on(event: string, handler: (...args: never[]) => unknown): () => void
  emit(event: string, ...args: unknown[]): unknown
  effect(setup: () => void | (() => void), name?: string): void
  inject<T extends readonly string[]>(
    services: T,
    callback: (serviceCtx: CordisContext) => void,
  ): void
  /** Optional service access by name (undefined when absent). */
  get(name: string): unknown
  plugin(module: unknown): unknown
}

// ── sessions (packages/core/session) ────────────────────────────────────────

export type SessionId = string & { readonly __brand: 'SessionId' }

export interface UserMessageSource {
  kind: 'user' | 'plugin' | 'model' | 'tool'
  plugin?: string
  form?: 'instructions' | 'catalog' | 'snapshot' | 'notice' | 'relay' | 'recall'
  summary?: string
  sections?: Array<{ name: string; text: string }>
}

export interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: ContentBlock[] | string
  isError?: boolean
}

export interface SessionMessage {
  id: string
  role: 'system' | 'user' | 'assistant'
  content: ContentBlock[]
  source: UserMessageSource
}

export interface SessionEventData {
  'turn/start': { turn: number }
  'turn/end': { turn: number; reason: { kind: string } }
  'step/start': { turn: number; step: number }
  'step/end': { turn: number; step: number }
  'user/message': SessionMessage & { role: 'user' }
  'assistant/message': { turn: number; step: number; message: SessionMessage & { role: 'assistant' } }
  'tool/call': { turn: number; step: number; callId: string; name: string; arguments: string }
  'tool/result': { turn: number; step: number; message: SessionMessage }
}

/** Distributed union so `switch (event.type)` narrows `event.data`. */
export type SessionEvent<T extends keyof SessionEventData = keyof SessionEventData> = T extends unknown
  ? { type: T; seq: number; time: number; data: SessionEventData[T] }
  : never

export interface SessionHeader {
  version: string
  id: SessionId
  createdAt: number
  cwd?: string
  parentSession?: SessionId
  isSeeded: boolean
  origin?: 'subagent'
  delegationDepth?: number
  agentPreset?: string
}

// ── session persistence (packages/session/session-persistence) ───────────────

export interface SessionPersistenceSnapshot {
  header: SessionHeader
  revision: unknown
  eventCount?: number
  sizeBytes?: number
}

export interface SessionHandle {
  readonly id: SessionId
  readonly header: SessionHeader
  read(offset?: number, length?: number, options?: { signal?: AbortSignal }): Promise<{
    eventState: string
    events: SessionEvent[]
  }>
  close(): Promise<void>
}

export interface SessionPersistence {
  list(options?: { signal?: AbortSignal }): Promise<SessionPersistenceSnapshot[]>
  stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<SessionPersistenceSnapshot | undefined>
  open(id: SessionId, access: 'read' | 'write', options?: { signal?: AbortSignal }): Promise<SessionHandle>
}

// ── llm (packages/llm) ──────────────────────────────────────────────────────

export type StreamChunk =
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'block-start'; index: number; blockType: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: { kind: string; failure?: { message?: string; code?: string; status?: number } }; replayState?: unknown }

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
}

export interface GenerateOptions {
  provider: string
  model: string
  messages: Array<{ id: string; role: 'user'; content: ContentBlock[]; source: UserMessageSource }>
  system?: string
  maxTokens?: number
  /** Reasoning effort id ('off' | 'low' | 'high' | 'max'); omitted keeps the model default. */
  reasoningEffort?: string
  signal?: AbortSignal
}

export interface LlmModelSelection {
  provider?: string
  model?: string
}

export interface LlmRuntime {
  stream(options: GenerateOptions): AsyncIterable<StreamChunk>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<{
    context?: { contextWindow: number }
  }>
}

// ── system prompt (packages/core/system-prompt) ─────────────────────────────

export interface PromptContext {
  name: string
  order: number
  text: string | ((context: { scope?: string; signal?: AbortSignal }) => string)
}

export interface SystemPromptService {
  context(context: PromptContext): () => void
  getContextOrder(name: string): number
}

// ── tools (packages/core/tools) ─────────────────────────────────────────────

export interface ToolExecution {
  readonly callId: string
  readonly name: string
  readonly arguments: Record<string, unknown>
}

export interface ToolRuntime {
  register(definition: unknown): void
  restrict(filter: { allow?: string[]; deny?: string[] }): () => void
  /** Model-visible schemas for a scope; used to discover real tool names. */
  schemas?(scope?: unknown): Array<{ name: string }>
}

export interface AgentLike {
  readonly id: SessionId
  /** The live session log (used for post-run diagnostics). */
  readonly session: { snapshotEvents(): Array<{ type: string }> }
  followup(message: { id: string; role: 'user'; content: ContentBlock[]; source: UserMessageSource }): void
  whenIdle(): Promise<void>
  cancel(cause: { kind: string }, options?: { keepInbox?: boolean }): void
}

export interface AgentHandle {
  agent: AgentLike
  dispose(): Promise<void>
}

export interface CreateAgentOptions {
  sessionId?: SessionId
  parentAgent?: AgentLike
  meta?: { cwd?: string; origin?: 'subagent'; delegationDepth?: number }
  /** Per-agent loop options (model route, token cap). */
  agentOptions?: { provider?: string; model?: string; maxTokens?: number }
  setup?: (agentCtx: DshContext, agent: AgentLike) => void | { commit(): void }
  signal?: AbortSignal
}

export interface AgentRegistry {
  create(options: CreateAgentOptions): Promise<AgentHandle>
  get(id: SessionId): AgentLike | undefined
  list(): AgentLike[]
}

/** Agent preset composition service (optional in a composition). */
export interface AgentPresetsService {
  /** Compose the default (or named) preset onto an agent scope. */
  mount(agentCtx: unknown, id?: string): Promise<unknown>
}

// ── agent default model ─────────────────────────────────────────────────────

export interface AgentDefaultModelService {
  currentSelection(): LlmModelSelection
}

// ── settings (packages/settings/settings) ───────────────────────────────────

export interface SettingsOwnerScope {
  get(): unknown
  watch(callback: (next: unknown, prev: unknown) => void | Promise<void>): () => void
  update(patch: object): Promise<void>
  replace(section: object): Promise<void>
}

/** The settings provider face this plugin uses (optional in a composition). */
export interface SettingsProviderFace {
  installSection(
    owner: unknown,
    ns: string,
    schema: unknown,
    entry: unknown,
    hooks: {
      validate?: (value: unknown) => void
      setSource: (get: () => Record<string, unknown>) => void
      onChange: () => void
    },
  ): void
  register(ns: string, schema: unknown, options?: { base?: unknown }): SettingsOwnerScope
}

// ── assembly ────────────────────────────────────────────────────────────────

/** The dsh Context as this plugin consumes it (documented service names). */
export interface DshContext extends CordisContext {
  tools: ToolRuntime
  llm: LlmRuntime
  systemPrompt: SystemPromptService
  sessionPersistence: SessionPersistence
  agents: AgentRegistry
  agentDefaultModel: AgentDefaultModelService
  settings?: SettingsProviderFace
  agentPresets?: AgentPresetsService
}
