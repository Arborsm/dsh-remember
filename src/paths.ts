import os from 'node:os'
import path from 'node:path'

export const MEMORY_FILE_NAME = 'MEMORY.md'
export const MEMORY_SUMMARY_FILE_NAME = 'memory_summary.md'
export const RAW_MEMORIES_FILE_NAME = 'raw_memories.md'
export const PHASE2_DIFF_FILE_NAME = 'phase2_workspace_diff.md'
export const ROLLOUT_SUMMARIES_DIR_NAME = 'rollout_summaries'
export const AD_HOC_NOTES_DIR_REL = 'extensions/ad_hoc/notes'
export const SKILLS_DIR_NAME = 'skills'

/** Resolved filesystem locations for one plugin instance. */
export interface MemoryPaths {
  /** Absolute workspace root (the git repository of memory files). */
  workspaceRoot: string
  /** Absolute SQLite database path. */
  dbPath: string
}

export function resolveMemoryPaths(config: { workspaceDir?: string; dbPath?: string }): MemoryPaths {
  const base = path.join(os.homedir(), '.dsh-memory')
  const workspaceRoot = path.resolve(
    config.workspaceDir && config.workspaceDir.trim() !== '' ? config.workspaceDir : path.join(base, 'memories'),
  )
  const dbPath = path.resolve(
    config.dbPath && config.dbPath.trim() !== '' ? config.dbPath : path.join(base, 'memories.sqlite'),
  )
  return { workspaceRoot, dbPath }
}

/** Forward-slash display form used inside prompts and stored references. */
export function displayPath(absolute: string): string {
  return absolute.replace(/\\/g, '/')
}
