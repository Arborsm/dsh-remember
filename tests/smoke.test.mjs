import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryDatabase } from '../src/db.ts'
import { classifyWorkspaceFile, shortHash, rolloutFileName, sanitizeSlug, writeTextFileIfChanged } from '../src/workspace.ts'
import { parseExtractionResponse } from '../src/phase1.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mem-test-'))

// ── db: schema + lease semantics ─────────────────────────────────────────────
{
  const db = new MemoryDatabase(path.join(tmp, 'mem.sqlite'))
  // first claim succeeds
  const c1 = db.tryClaimPhase1Job('session-a', 100, 60, 3)
  assert.equal(c1.claimed, true)
  // second claim while lease active fails
  const c2 = db.tryClaimPhase1Job('session-a', 100, 60, 3)
  assert.equal(c2.claimed, false, 'lease should block second claim')
  // success writes row + watermark
  const record = {
    sessionId: 'session-a', workspacePath: 'E:/demo', rolloutPath: 'rollout_summaries/x.md',
    sourceUpdatedAt: 100, rawMemory: 'raw', rolloutSummary: 'summary', rolloutSlug: 'raw-demo',
    generatedAt: 100, usageCount: 0, lastUsage: null, selectedForPhase2: false,
    selectedForPhase2SourceUpdatedAt: null,
  }
  db.markPhase1Succeeded('session-a', c1.token, record)
  const stored = db.getStage1('session-a')
  assert.equal(stored.rawMemory, 'raw')
  // watermark-current blocks re-claim at same or older watermark
  const c3 = db.tryClaimPhase1Job('session-a', 100, 60, 3)
  assert.equal(c3.claimed, false, 'fresh watermark should block re-claim')
  // newer watermark re-claims
  const c4 = db.tryClaimPhase1Job('session-a', 200, 60, 3)
  assert.equal(c4.claimed, true, 'newer watermark should re-claim')
  // failure backs off
  db.markPhase1Failure('session-a', c4.token, 'boom', 1)
  const c5 = db.tryClaimPhase1Job('session-a', 200, 60, 3)
  assert.equal(c5.claimed, false, 'retry_at should block immediate re-claim')

  // upsert watermark guard: older source_updated_at must not overwrite
  db.upsertStage1({ ...record, sourceUpdatedAt: 50, rawMemory: 'stale' }, false)
  assert.equal(db.getStage1('session-a').rawMemory, 'raw', 'stale upsert must not apply')

  // citations
  db.recordCitationUsage(['session-a'], [])
  assert.equal(db.getStage1('session-a').usageCount, 1)

  // phase2 candidates: selected rows excluded
  db.markPhase2CandidatesSelected(['session-a'], 200)
  assert.equal(db.listPhase2Candidates().length, 0)
  assert.equal(db.listSelected().length, 1)

  // prune: unselected old rows go
  const db2 = new MemoryDatabase(path.join(tmp, 'mem2.sqlite'))
  const old = { ...record, sessionId: 'old', generatedAt: 1, lastUsage: 1, selectedForPhase2: false }
  db2.upsertStage1(old, true)
  db2.markPhase1SucceededNoOutput('never', 'tok')
  assert.equal(db2.pruneStage1ForRetention(0.0001), 1, 'old unselected row pruned')
  assert.equal(db2.getStage1('old'), undefined)
  db.close(); db2.close()
}

// ── workspace helpers ────────────────────────────────────────────────────────
{
  assert.equal(classifyWorkspaceFile('MEMORY.md'), 'index')
  assert.equal(classifyWorkspaceFile('memory_summary.md'), 'summary')
  assert.equal(classifyWorkspaceFile('extensions/ad_hoc/notes/2026-01-01-note.md'), 'ad_hoc_note')
  assert.equal(classifyWorkspaceFile('raw_memories.md'), null)
  assert.equal(classifyWorkspaceFile('../escape.md'), null)
  assert.equal(classifyWorkspaceFile('skills/x/SKILL.md'), null, 'skills imported via records, not classify')
  assert.equal(shortHash('session-a').length, 4)
  assert.ok(/^[a-z0-9_-]{1,80}$/.test(sanitizeSlug('Hello World!! test')))
  assert.equal(rolloutFileName({ sessionId: 's1', rolloutSlug: 'Fix Bug', generatedAt: 10 }).endsWith('-fix-bug.md'), true)

  const file = path.join(tmp, 'atomic', 'a.txt')
  assert.equal(writeTextFileIfChanged(file, 'one'), true)
  assert.equal(writeTextFileIfChanged(file, 'one'), false, 'unchanged write is a no-op')
  assert.equal(writeTextFileIfChanged(file, 'two'), true)
}

// ── extraction parsing ───────────────────────────────────────────────────────
{
  const reply = [
    'junk before',
    '<<<RAW_MEMORY_BEGIN>>>', '---', 'description: d', '---', 'raw body', '<<<RAW_MEMORY_END>>>',
    '<<<ROLLOUT_SUMMARY_BEGIN>>>', '# summary', '<<<ROLLOUT_SUMMARY_END>>>',
    '<<<ROLLOUT_SLUG_BEGIN>>>', 'fix-login-bug', '<<<ROLLOUT_SLUG_END>>>',
  ].join('\n')
  const parsed = parseExtractionResponse(reply)
  assert.equal(parsed.rawMemory.includes('raw body'), true)
  assert.equal(parsed.rolloutSummary, '# summary')
  assert.equal(parsed.rolloutSlug, 'fix-login-bug')

  const noop = '<<<RAW_MEMORY_BEGIN>>>\n<<<RAW_MEMORY_END>>>\n<<<ROLLOUT_SUMMARY_BEGIN>>>\n<<<ROLLOUT_SUMMARY_END>>>\n<<<ROLLOUT_SLUG_BEGIN>>>\n<<<ROLLOUT_SLUG_END>>>'
  const parsedNoop = parseExtractionResponse(noop)
  assert.equal(parsedNoop.rawMemory, '')
  assert.equal(parsedNoop.rolloutSlug, null)

  assert.equal(parseExtractionResponse('no markers at all'), null)
  const twoLineSlug = reply.replace('fix-login-bug', 'line1\nline2')
  assert.equal(parseExtractionResponse(twoLineSlug), null, 'multi-line slug rejected')
}

fs.rmSync(tmp, { recursive: true, force: true })
console.log('smoke tests passed')
