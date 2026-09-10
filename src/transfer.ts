import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRuntime } from './dsh-types.ts'
import type { MemoryDatabase, MemoryRecord } from './db.ts'
import type { MemoryPaths } from './paths.ts'
import { recordContentHash } from './db.ts'
import { classifyWorkspaceFile, readTextFileOrNull, writeTextFileIfChanged, ensureGitRepo, commitBaseline } from './workspace.ts'

export const TRANSFER_BUNDLE_SCHEMA = 'dsh-memory.bundle.v1'

export interface TransferManifest {
  schema: string
  source: string
  exportedAt: string
  fileCount: number
  recordCount: number
}

export interface TransferBundle {
  manifest: TransferManifest
  files: Array<{ relative: string; text: string }>
  records: MemoryRecord[]
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function readBundle(bundlePath: string): TransferBundle {
  // Single-file bundle: gzipped TransferBundle JSON, with a plain-JSON
  // fallback for uncompressed files.
  const raw = fs.readFileSync(bundlePath)
  // gzip magic 1f 8b; anything else is treated as plain JSON.
  const text = raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b
    ? gunzipSync(raw).toString('utf8')
    : raw.toString('utf8')
  const bundle = JSON.parse(text) as TransferBundle
  if (bundle.manifest?.schema !== TRANSFER_BUNDLE_SCHEMA) {
    throw new Error(`unsupported bundle schema: ${String(bundle.manifest?.schema)}`)
  }
  return { manifest: bundle.manifest, files: bundle.files ?? [], records: bundle.records ?? [] }
}

function collectFiles(root: string, dir: string, out: TransferBundle['files']): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectFiles(root, full, out)
      continue
    }
    if (!entry.isFile()) continue
    const relative = path.relative(root, full).replace(/\\/gu, '/')
    if (classifyWorkspaceFile(relative) == null) continue
    out.push({ relative, text: fs.readFileSync(full, 'utf8') })
  }
}

// ── export ──────────────────────────────────────────────────────────────────

export function buildExportBundle(paths: MemoryPaths, db: MemoryDatabase, source: string): TransferBundle {
  const files: TransferBundle['files'] = []
  const workspaceRoot = paths.workspaceRoot
  for (const relative of ['MEMORY.md', 'memory_summary.md']) {
    const text = readTextFileOrNull(path.join(workspaceRoot, relative))
    if (text != null) files.push({ relative, text })
  }
  const notesDir = path.join(workspaceRoot, 'extensions/ad_hoc/notes')
  if (fs.existsSync(notesDir)) {
    collectFiles(workspaceRoot, notesDir, files)
  }
  return {
    manifest: {
      schema: TRANSFER_BUNDLE_SCHEMA,
      source,
      exportedAt: new Date().toISOString(),
      fileCount: files.length,
      recordCount: db.listStage1().length,
    },
    files,
    records: db.listStage1(),
  }
}

/** Write the whole bundle as one gzipped JSON file (`.dshmem.json` by convention). */
export function writeExportBundle(bundle: TransferBundle, destFile: string): TransferManifest {
  fs.mkdirSync(path.dirname(destFile), { recursive: true })
  fs.writeFileSync(destFile, gzipSync(JSON.stringify(bundle)))
  return bundle.manifest
}

// ── import ──────────────────────────────────────────────────────────────────

export interface ImportOutcome {
  imported: number
  duplicate: number
  targetWins: number
  filesImported: number
  filesRemapped: number
}

/**
 * Merge a transfer bundle into the live store: same id + same content =
 * duplicate skip, same id + different content = target wins, content-hash
 * dedup across ids, note-path collisions remap deterministically.
 */
export async function importBundle(bundlePath: string, db: MemoryDatabase, paths: MemoryPaths): Promise<ImportOutcome> {
  const bundle = readBundle(bundlePath)
  const outcome: ImportOutcome = { imported: 0, duplicate: 0, targetWins: 0, filesImported: 0, filesRemapped: 0 }

  const existing = db.listStage1()
  const existingById = new Map(existing.map((record) => [record.sessionId, record]))
  const occupiedHashes = new Set(existing.map((record) => recordContentHash(record)))

  for (const raw of bundle.records) {
    const record: MemoryRecord = { ...raw, selectedForPhase2: false, selectedForPhase2SourceUpdatedAt: null }
    if (record.sessionId.trim() === '') continue
    const contentHash = recordContentHash(record)
    const current = existingById.get(record.sessionId)
    if (current) {
      if (recordContentHash(current) === contentHash) {
        outcome.duplicate += 1
      } else {
        outcome.targetWins += 1
      }
      continue
    }
    if (occupiedHashes.has(contentHash)) {
      outcome.duplicate += 1
      continue
    }
    occupiedHashes.add(contentHash)
    existingById.set(record.sessionId, record)
    db.upsertStage1(record, true)
    outcome.imported += 1
  }

  const occupiedPaths = new Set<string>()
  for (const file of fs.readdirSync(paths.workspaceRoot, { recursive: true })) {
    occupiedPaths.add(String(file).replace(/\\/gu, '/'))
  }

  for (const file of bundle.files) {
    let relative = file.relative
    const target = path.join(paths.workspaceRoot, relative)
    const existingText = readTextFileOrNull(target)
    if (existingText != null) {
      const kind = classifyWorkspaceFile(relative)
      if (kind === 'ad_hoc_note' && existingText.trim() !== file.text.trim()) {
        const shortHash = sha256(file.text).slice(0, 8)
        const stem = relative.replace(/\.md$/u, '')
        let suffix = 0
        let candidate = `${stem}-from-import-${shortHash}.md`
        while (occupiedPaths.has(candidate)) {
          suffix += 1
          candidate = `${stem}-from-import-${shortHash}-${suffix}.md`
        }
        relative = candidate
        outcome.filesRemapped += 1
      } else {
        outcome.duplicate += 1
        continue
      }
    }
    writeTextFileIfChanged(path.join(paths.workspaceRoot, relative), file.text)
    occupiedPaths.add(relative)
    outcome.filesImported += 1
  }

  // Imported evidence re-enters consolidation on the next Phase 2 run; the
  // baseline reset makes the next git diff show the imported files as added.
  // Awaited so concurrent imports serialize their git operations.
  await ensureGitRepo(paths.workspaceRoot)
  await commitBaseline(paths.workspaceRoot, 'memory import applied')
  return outcome
}

// ── model tools ─────────────────────────────────────────────────────────────

export function registerTransferTools(tools: ToolRuntime, db: MemoryDatabase, paths: MemoryPaths): void {
  tools.register(defineTool({
    name: 'memory_export',
    description: 'Export the long-term memory workspace and stage-1 records into a single gzip-compressed bundle file.',
    parameters: {
      destPath: { type: 'string', required: true, description: 'Absolute file path for the bundle, e.g. C:\\backups\\memory.dshmem.json' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { destPath: string }) {
      const dest = path.resolve(args.destPath)
      if (dest === paths.workspaceRoot || dest.startsWith(paths.workspaceRoot + path.sep)) {
        return 'refused: export destination must be outside the memory workspace'
      }
      const bundle = buildExportBundle(paths, db, 'dsh')
      const manifest = writeExportBundle(bundle, dest)
      return `exported ${manifest.recordCount} records and ${manifest.fileCount} files to ${dest}`
    },
  }))

  tools.register(defineTool({
    name: 'memory_import',
    description: 'Import a memory bundle file produced by memory_export, merging it into the live memory store.',
    parameters: {
      srcPath: { type: 'string', required: true, description: 'Absolute path of the bundle file (gzipped or plain JSON)' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args: Record<string, unknown>, value: string) => [{ type: 'text', text: value }],
    },
    async execute(args: { srcPath: string }) {
      const outcome = await importBundle(path.resolve(args.srcPath), db, paths)
      return [
        `imported records: ${outcome.imported}`,
        `duplicates skipped: ${outcome.duplicate}`,
        `target-wins conflicts: ${outcome.targetWins}`,
        `files imported: ${outcome.filesImported}`,
        `notes remapped: ${outcome.filesRemapped}`,
      ].join('; ')
    },
  }))
}
