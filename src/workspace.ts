import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'

import type { MemoryRecord } from './db.ts'
import {
  AD_HOC_NOTES_DIR_REL,
  MEMORY_FILE_NAME,
  MEMORY_SUMMARY_FILE_NAME,
  PHASE2_DIFF_FILE_NAME,
  RAW_MEMORIES_FILE_NAME,
  ROLLOUT_SUMMARIES_DIR_NAME,
} from './paths.ts'

const execFileAsync = promisify(execFile)

export type WorkspaceFileKind = 'index' | 'summary' | 'ad_hoc_note'

/**
 * Classify a workspace-relative path against the owner contract. Returns null
 * for anything outside it — including path escapes and generated files.
 */
export function classifyWorkspaceFile(relativePath: string): WorkspaceFileKind | null {
  const parts = relativePath.split(/[\\/]/u)
  if (parts.length === 0 || parts.some((part) => part === '' || part === '.' || part === '..')) {
    return null
  }
  if (parts.length === 1) {
    if (parts[0] === MEMORY_FILE_NAME) return 'index'
    if (parts[0] === MEMORY_SUMMARY_FILE_NAME) return 'summary'
    return null
  }
  const notesParts = AD_HOC_NOTES_DIR_REL.split('/')
  if (
    parts.length > notesParts.length
    && notesParts.every((part, index) => parts[index] === part)
    && parts[parts.length - 1]?.endsWith('.md')
  ) {
    return 'ad_hoc_note'
  }
  return null
}

export function memorySummaryFile(root: string): string {
  return path.join(root, MEMORY_SUMMARY_FILE_NAME)
}

export function rawMemoriesFile(root: string): string {
  return path.join(root, RAW_MEMORIES_FILE_NAME)
}

export function phase2DiffFile(root: string): string {
  return path.join(root, PHASE2_DIFF_FILE_NAME)
}

// ── atomic file helpers ─────────────────────────────────────────────────────

export function writeTextFileIfChanged(file: string, text: string): boolean {
  const previous = readTextFileOrNull(file)
  if (previous === text) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, text, 'utf8')
  fs.renameSync(tmp, file)
  return true
}

export function readTextFileOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function removeFileIfPresent(file: string): void {
  try {
    fs.rmSync(file, { force: true })
  } catch {
    // best effort
  }
}

// ── git operations ──────────────────────────────────────────────────────────

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync('git', args, { cwd: root, windowsHide: true })
  return result.stdout
}

/** Ensure the workspace is a git repository (idempotent). */
export async function ensureGitRepo(root: string): Promise<void> {
  fs.mkdirSync(root, { recursive: true })
  if (fs.existsSync(path.join(root, '.git'))) return
  await git(root, ['init', '--quiet'])
  // Only the regenerated diff report stays out of version control:
  // raw_memories.md changes MUST appear in the Phase 2 diff (it is the
  // ingestion queue the consolidator routes on).
  await writeTextFileIfChanged(path.join(root, '.gitignore'), 'phase2_workspace_diff.md\n')
}

/** Commit the current worktree state and return the baseline commit hash. */
export async function commitBaseline(root: string, message: string): Promise<string> {
  await git(root, ['add', '-A'])
  try {
    await git(root, ['commit', '--quiet', '--allow-empty', '-m', message])
  } catch (error) {
    // git commit fails when nothing is staged AND user identity is missing;
    // identity failures must surface, empty commits are fine to ignore.
    const text = String(error)
    if (!text.includes('nothing to commit')) throw error
  }
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, windowsHide: true })
  return stdout.trim()
}

export interface WorkspaceDiff {
  /** git name-status entries against the baseline. */
  changes: Array<{ status: string; file: string }>
  /** Full diff text written to phase2_workspace_diff.md. */
  text: string
  hasChanges: boolean
}

export async function diffAgainstBaseline(root: string, baseline: string): Promise<WorkspaceDiff> {
  const nameStatus = await git(root, ['diff', '--name-status', baseline, '--', '.'])
  const changes = nameStatus
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const [status, file] = line.split(/\t+/u)
      return { status: status ?? 'M', file: file ?? '' }
    })
    .filter((entry) => entry.file !== '')
  const text = await git(root, ['diff', baseline, '--', '.']).catch(() => nameStatus)
  return { changes, text, hasChanges: changes.length > 0 }
}

/** Re-baseline after a successful Phase 2 run. */
export async function resetBaseline(root: string, message: string): Promise<void> {
  await commitBaseline(root, message)
}

// ── workspace sync (Phase 2 inputs) ─────────────────────────────────────────

/** 4-char base62 fingerprint of a session id, used in rollout file names. */
export function shortHash(sessionId: string): string {
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const digest = createHash('sha256').update(sessionId).digest()
  let value = BigInt(`0x${digest.subarray(0, 8).toString('hex')}`)
  let out = ''
  for (let i = 0; i < 4; i += 1) {
    out += alphabet[Number(value % 62n)]
    value /= 62n
  }
  return out
}

export function sanitizeSlug(slug: string): string {
  const cleaned = slug.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return cleaned === '' ? 'rollout' : cleaned.slice(0, 80)
}

export function rolloutFileName(record: MemoryRecord): string {
  const stamp = Math.max(0, record.generatedAt) * 1000
  const slug = sanitizeSlug(record.rolloutSlug ?? record.sessionId)
  return `${stamp}-${shortHash(record.sessionId)}-${slug}.md`
}

export function rolloutPathFor(record: MemoryRecord): string {
  return `${ROLLOUT_SUMMARIES_DIR_NAME}/${rolloutFileName(record)}`
}

export function renderRolloutSummaryFile(record: MemoryRecord): string {
  const header = [
    `# Rollout summary: ${record.rolloutSlug ?? record.sessionId}`,
    '',
    `- session_id: ${record.sessionId}`,
    `- workspace_path: ${record.workspacePath}`,
    `- rollout_path: ${record.rolloutPath}`,
    `- updated_at: ${new Date(record.sourceUpdatedAt * 1000).toISOString()}`,
    '- source: dsh-memory-plugin',
    '',
  ].join('\n')
  return `${header}${record.rolloutSummary.trim()}\n`
}

export function renderRawMemoriesFile(records: MemoryRecord[]): string {
  const sections = records.map((record) => {
    const body = record.rawMemory.trim() === '' ? '(empty)' : record.rawMemory.trim()
    return [
      `<<<SESSION ${record.sessionId}>>>`,
      `workspace_path: ${record.workspacePath}`,
      `rollout_path: ${record.rolloutPath}`,
      `updated_at: ${new Date(record.sourceUpdatedAt * 1000).toISOString()}`,
      '',
      body,
      `<<<END SESSION ${record.sessionId}>>>`,
      '',
    ].join('\n')
  })
  return ['# Raw memories (Phase 1 output, mechanically merged)', '', ...sections].join('\n')
}

export interface WorkspaceSyncResult {
  rawMemoriesWritten: boolean
  rolloutsAdded: string[]
  rolloutsRemoved: string[]
  rolloutCount: number
}

/**
 * Sync Phase 2 inputs into the workspace: `raw_memories.md` over the full
 * candidate set, rollout summaries added for every record that has one
 * (candidates ∪ previously selected), and stale rollout files removed — a
 * removal is what drives evidence-backed forgetting.
 */
export async function syncWorkspaceInputs(
  root: string,
  candidateRecords: MemoryRecord[],
  selectedRecords: MemoryRecord[],
  maxRolloutSummaries: number,
): Promise<WorkspaceSyncResult> {
  const ordered = [...candidateRecords].sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1))
  const rawWritten = writeTextFileIfChanged(rawMemoriesFile(root), renderRawMemoriesFile(ordered))

  const keep = new Map<string, { file: string; text: string }>()
  const seen = new Set<string>()
  for (const record of [...candidateRecords, ...selectedRecords]) {
    if (seen.has(record.sessionId)) continue
    seen.add(record.sessionId)
    if (record.rolloutSummary.trim() === '') continue
    const file = rolloutFileName(record)
    keep.set(file, { file, text: renderRolloutSummaryFile(record) })
    if (keep.size >= maxRolloutSummaries) break
  }

  const rolloutsDir = path.join(root, ROLLOUT_SUMMARIES_DIR_NAME)
  fs.mkdirSync(rolloutsDir, { recursive: true })
  const existing = fs.readdirSync(rolloutsDir).filter((name) => name.endsWith('.md'))
  const rolloutsRemoved: string[] = []
  for (const name of existing) {
    if (!keep.has(name)) {
      removeFileIfPresent(path.join(rolloutsDir, name))
      rolloutsRemoved.push(name)
    }
  }
  const rolloutsAdded: string[] = []
  for (const { file, text } of keep.values()) {
    if (writeTextFileIfChanged(path.join(rolloutsDir, file), text)) {
      rolloutsAdded.push(file)
    }
  }

  return {
    rawMemoriesWritten: rawWritten,
    rolloutsAdded,
    rolloutsRemoved,
    rolloutCount: keep.size,
  }
}
