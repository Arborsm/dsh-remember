// Round-trip test: bundle file → importBundle → buildExportBundle → importBundle.
// Run: node --import ./tests/register-hooks.mjs tests/transfer.test.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

import { MemoryDatabase } from '../src/db.ts'
import { buildExportBundle, importBundle, writeExportBundle } from '../src/transfer.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-transfer-'))
const workspace = path.join(tmp, 'memories')
fs.mkdirSync(workspace, { recursive: true })
const db = new MemoryDatabase(path.join(tmp, 'mem.sqlite'))
const paths = { workspaceRoot: workspace, dbPath: path.join(tmp, 'mem.sqlite') }

/** Write a bundle as the exporter would: gzipped TransferBundle JSON. */
function writeBundle(name, records, files) {
  const file = path.join(tmp, `${name}.json`)
  fs.writeFileSync(file, gzipSync(JSON.stringify({
    manifest: {
      schema: 'dsh-memory.bundle.v1',
      source: 'dsh',
      exportedAt: new Date().toISOString(),
      fileCount: files.length,
      recordCount: records.length,
    },
    files,
    records,
  })))
  return file
}

const record = (id, overrides = {}) => ({
  sessionId: id,
  workspacePath: 'E:/demo',
  rolloutPath: `rollout_summaries/${id}.md`,
  sourceUpdatedAt: 100,
  rawMemory: `raw ${id}`,
  rolloutSummary: `summary ${id}`,
  rolloutSlug: id,
  generatedAt: 100,
  usageCount: 0,
  lastUsage: null,
  selectedForPhase2: true,
  selectedForPhase2SourceUpdatedAt: null,
  ...overrides,
})

// 1. A bundle carrying records and workspace files.
const bundleFile = writeBundle('bundle', [
  record('sess-1', { usageCount: 2, lastUsage: 90 }),
  record('sess-2', { sourceUpdatedAt: 200, rolloutPath: '' }),
], [
  { relative: 'MEMORY.md', text: '# Task Group: demo\n' },
  { relative: 'memory_summary.md', text: 'v1\n\nfixture summary\n' },
  { relative: 'extensions/ad_hoc/notes/note-a.md', text: 'remembered\n' },
])

// 2. Import.
const outcome = await importBundle(bundleFile, db, paths)
assert.equal(outcome.imported, 2, 'both records imported')
assert.equal(outcome.filesImported, 3)

// Imported rows re-enter consolidation candidates (selection no longer gates
// the input query; the huge retention window keeps the old fixture rows fresh).
const candidates = db.listPhase2Candidates(100000).map((row) => row.sessionId).sort()
assert.deepEqual(candidates, ['sess-1', 'sess-2'], 'imported rows are consolidation candidates')

// Files landed in the workspace.
assert.equal(fs.readFileSync(path.join(workspace, 'MEMORY.md'), 'utf8'), '# Task Group: demo\n')
assert.ok(fs.existsSync(path.join(workspace, 'extensions', 'ad_hoc', 'notes', 'note-a.md')))

// 3. Re-import: same id + same content = duplicate skip.
const again = await importBundle(bundleFile, db, paths)
assert.equal(again.imported, 0)
assert.equal(again.duplicate, 5, '2 records + 3 unchanged files deduped on re-import')
assert.equal(again.filesImported, 0, 'unchanged files skipped on re-import')

// 4. Conflicting id: target wins.
const conflictFile = writeBundle('conflict', [
  record('sess-1', { workspacePath: 'E:/other', sourceUpdatedAt: 999, rawMemory: 'DIFFERENT' }),
], [])
const conflict = await importBundle(conflictFile, db, paths)
assert.equal(conflict.targetWins, 1, 'same id, different content → target wins')
assert.equal(db.getStage1('sess-1').rawMemory, 'raw sess-1')

// 5. Conflicting ad-hoc note: deterministic remap.
const noteFile = writeBundle('notes', [], [
  { relative: 'extensions/ad_hoc/notes/note-a.md', text: 'a different note\n' },
])
const noteResult = await importBundle(noteFile, db, paths)
assert.equal(noteResult.filesRemapped, 1, 'colliding note remapped')
const remapped = fs.readdirSync(path.join(workspace, 'extensions', 'ad_hoc', 'notes'))
assert.ok(remapped.some((name) => name.startsWith('note-a-from-import-')), `remapped note present: ${remapped.join(',')}`)

// 6. An unknown schema is refused instead of half-imported.
const badFile = path.join(tmp, 'bad.json')
fs.writeFileSync(badFile, gzipSync(JSON.stringify({ manifest: { schema: 'nope.v9' }, files: [], records: [] })))
await assert.rejects(() => importBundle(badFile, db, paths), /unsupported bundle schema/u)

// 7. Export from the live store round-trips the same data (gzipped single file).
const exportFile = path.join(tmp, 'export', 'memory.dshmem.json')
const bundle = buildExportBundle(paths, db, 'dsh')
writeExportBundle(bundle, exportFile)
const exported = JSON.parse(gunzipSync(fs.readFileSync(exportFile)).toString('utf8'))
assert.equal(exported.records.length, 2)
assert.equal(exported.manifest.source, 'dsh')
assert.ok(exported.files.some((file) => file.relative === 'MEMORY.md'))

// 7b. A plain (uncompressed) JSON bundle still imports.
const plainFile = path.join(tmp, 'export', 'plain.json')
fs.writeFileSync(plainFile, JSON.stringify(bundle))
const workspacePlain = path.join(tmp, 'memories-plain')
fs.mkdirSync(workspacePlain, { recursive: true })
const dbPlain = new MemoryDatabase(path.join(tmp, 'mem-plain.sqlite'))
const plainOutcome = await importBundle(plainFile, dbPlain, { workspaceRoot: workspacePlain, dbPath: path.join(tmp, 'mem-plain.sqlite') })
assert.equal(plainOutcome.imported, 2, 'uncompressed bundle imports')
dbPlain.close()

// 8. The exported file imports back into an empty store.
const workspace2 = path.join(tmp, 'memories2')
fs.mkdirSync(workspace2, { recursive: true })
const db2 = new MemoryDatabase(path.join(tmp, 'mem2.sqlite'))
const reimport = await importBundle(exportFile, db2, { workspaceRoot: workspace2, dbPath: path.join(tmp, 'mem2.sqlite') })
assert.equal(reimport.imported, 2, 'exported records import')
assert.ok(reimport.filesImported >= 2, 'exported files import')
db2.close()

db.close()
try {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
} catch {
  // Windows can briefly hold the closed SQLite file; cleanup is best-effort.
}
console.log('transfer round-trip test passed')
