import Schema from '@deepseek-ai/schemastery'

export interface MemoryPluginConfig {
  /** Master switch; when false nothing runs and nothing is injected. */
  enabled: boolean
  /** Extract memories from idle sessions (Phase 1). */
  generateMemories: boolean
  /** Inject memory_summary.md into each assembly (read path). */
  useMemories: boolean
  /** Root of the file-based memory workspace (a git repository). */
  workspaceDir?: string
  /** SQLite database file for stage-1 outputs and job state. */
  dbPath?: string
  /** Extraction model as `provider/model`; falls back to the default selection. */
  extractModel?: string
  /** Consolidation agent model as `provider/model`; falls back to the default selection. */
  consolidationModel?: string
  /** A session is eligible once it has been idle this many hours. */
  minRolloutIdleHours: number
  /** Sessions older than this are never extracted. */
  maxSessionAgeDays: number
  /** Unselected stage-1 rows older than this are pruned. */
  maxUnusedDays: number
  /** Background scheduler interval in minutes. */
  scanIntervalMinutes: number
  /** Head token cap applied to memory_summary.md before injection. */
  summaryTokenLimit: number
  /** Fraction of the extraction model's context window usable as transcript input. */
  extractInputContextRatio: number
  /** Cooldown after a successful Phase 2 run (watermark unchanged). */
  phase2SuccessCooldownSeconds: number
  /** Hard timeout for the Phase 2 consolidation agent. */
  phase2TimeoutMinutes: number
  /** Base delay for Phase 1 retry backoff. */
  phase1RetryBackoffMinutes: number
  /** Phase 1 attempts before a session is parked. */
  phase1MaxRetries: number
  /** Maximum sessions extracted per scheduler cycle. */
  phase1MaxPerCycle: number
  /** Concurrent extractions within one cycle. */
  phase1MaxConcurrency: number
  /** Cap on how many rollout summary files are synced into the workspace. */
  maxRolloutSummaries: number
  /** Attempt Phase 2 once at process startup when unconsolidated candidates exist. */
  runPhase2OnStartup: boolean
  /** Tool-name deny patterns (regex sources) for the Phase 2 consolidator. */
  consolidatorDenyPatterns: string[]
  /** Redact known secret shapes from extraction transcripts. */
  redactSecrets: boolean
}

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('Master switch for the memory system.'),
  generateMemories: Schema.boolean()
    .default(true)
    .description('Extract memories from idle sessions (Phase 1) and consolidate them (Phase 2).'),
  useMemories: Schema.boolean()
    .default(true)
    .description('Inject memory_summary.md into every prompt assembly (read path).'),
  workspaceDir: Schema.string()
    .default('')
    .description('Memory workspace root (git repo). Empty = ~/.dsh-memory/memories.'),
  dbPath: Schema.string()
    .default('')
    .description('SQLite database path. Empty = ~/.dsh-memory/memories.sqlite.'),
  extractModel: Schema.string()
    .default('')
    .description('Extraction model as `provider/model`. Empty = deployment default model.'),
  consolidationModel: Schema.string()
    .default('')
    .description('Phase 2 consolidator model as `provider/model`. Empty = deployment default model.'),
  minRolloutIdleHours: Schema.number().min(1).max(48).default(1)
    .description('Hours a session must be idle before extraction.'),
  maxSessionAgeDays: Schema.number().min(1).default(90)
    .description('Skip sessions older than this many days.'),
  maxUnusedDays: Schema.number().min(1).default(30)
    .description('Prune stage-1 rows not selected by Phase 2 after this many unused days.'),
  scanIntervalMinutes: Schema.number().min(1).max(1440).default(15)
    .description('Background scheduler interval.'),
  runPhase2OnStartup: Schema.boolean().default(true)
    .description('Attempt Phase 2 once at startup when unconsolidated candidates exist.'),
  summaryTokenLimit: Schema.number().min(200).max(20000).default(2500)
    .description('Token cap for the injected memory summary (approx. 4 bytes/token).'),
  extractInputContextRatio: Schema.number().min(0.1).max(0.95).default(0.7)
    .description('Fraction of the extraction context window available as transcript input.'),
  phase2SuccessCooldownSeconds: Schema.number().min(0).default(3600)
    .description('Cooldown after a successful Phase 2 with an unchanged watermark.'),
  phase2TimeoutMinutes: Schema.number().min(1).max(120).default(20)
    .description('Hard timeout for the Phase 2 consolidation agent.'),
  phase1RetryBackoffMinutes: Schema.number().min(1).default(30)
    .description('Base delay for Phase 1 exponential retry backoff.'),
  phase1MaxRetries: Schema.number().min(0).max(10).default(3)
    .description('Phase 1 attempts per session before parking it.'),
  phase1MaxPerCycle: Schema.number().min(1).max(128).default(4)
    .description('Maximum sessions extracted per scheduler cycle.'),
  phase1MaxConcurrency: Schema.number().min(1).max(16).default(1)
    .description('Concurrent Phase 1 extractions within one cycle.'),
  maxRolloutSummaries: Schema.number().min(1).default(4096)
    .description('Maximum rollout summary files synced into the workspace.'),
  consolidatorDenyPatterns: Schema.array(Schema.string())
    .default([
      '^browser_',
      '^web_',
      '^(bash|pwsh|shell)$',
      '^subagent',
      '^run_code$',
      '^memory_(export|import)$',
      '^skill$',
      '^todo_write$',
      '^goal',
      '^workflow',
      '^ralph',
      '^job_',
      '^schedule',
    ])
    .description('Tool-name deny patterns (regex) for the Phase 2 consolidator.'),
  redactSecrets: Schema.boolean().default(true)
    .description('Redact known secret shapes from extraction transcripts.'),
})
