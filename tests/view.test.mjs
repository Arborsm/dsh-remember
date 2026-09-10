// Translation memory: segment cache, incremental re-translation, stale detection.
// Run: node --import ./tests/register-hooks.mjs tests/view.test.mjs
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { MemoryDatabase } from '../src/db.ts'
import { currentTranslation, publishMemoryView, translateMemory } from '../src/view.ts'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-view-'))
const workspace = path.join(tmp, 'memories')
fs.mkdirSync(workspace, { recursive: true })
const paths = { workspaceRoot: workspace, dbPath: path.join(tmp, 'mem.sqlite') }
const db = new MemoryDatabase(paths.dbPath)
const viewDb = Object.assign(db, { listStage1Stats: () => [{ sessionId: 's1' }] })

/** llm stub: "[zh] <segment>" per request, recording every request. */
const calls = []
const progress = []
const ctx = {
  llm: {
    stream: async function* (options) {
      const text = options.messages[0].content[0].text
      calls.push(text)
      yield { type: 'text-delta', text: `[zh] ${text}` }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  },
  agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
}
const config = {}

// 1. Segmented translation of a large registry + the summary.
const bigLines = Array.from({ length: 900 }, (_, index) => `- line ${index} of the registry`)
fs.writeFileSync(path.join(workspace, 'MEMORY.md'), `# Registry\n${bigLines.join('\n')}\n`)
fs.writeFileSync(path.join(workspace, 'memory_summary.md'), 'v1\n\nfixture summary\n')

const first = await translateMemory(ctx, viewDb, paths, config, 'zh', { onProgress: (entry) => progress.push(entry) })
assert.deepEqual(first.translated.sort(), ['index', 'summary'], 'both artifacts translated on the first run')
assert.deepEqual(first.cached, [], 'nothing cached on the first run')
assert.ok(calls.length > 10, `the registry was segmented (got ${calls.length} requests)`)
assert.equal(progress.length, calls.length, 'progress reported once per segment')
assert.equal(progress.at(-1).done, progress.at(-1).total, 'progress ends at 100%')
assert.ok(fs.existsSync(path.join(workspace, 'MEMORY.zh.md')), 'translated registry written')
assert.equal(currentTranslation(workspace).stale, false, 'fresh translation is not stale')

// 2. Nothing changed: no model request at all.
const requestsAfterFirst = calls.length
const second = await translateMemory(ctx, viewDb, paths, config, 'zh')
assert.deepEqual(second.cached.sort(), ['index', 'summary'], 'both artifacts served from the memory')
assert.equal(calls.length, requestsAfterFirst, 'an unchanged source issues no request')

// 3. One edited line re-translates only its own segment — the point of the TM.
const registry = fs.readFileSync(path.join(workspace, 'MEMORY.md'), 'utf8')
fs.writeFileSync(
  path.join(workspace, 'MEMORY.md'),
  registry.replace('- line 450 of the registry', '- line 450 was edited'),
)
const third = await translateMemory(ctx, viewDb, paths, config, 'zh')
const delta = calls.length - requestsAfterFirst
const registryAfter = fs.readFileSync(path.join(workspace, 'MEMORY.zh.md'), 'utf8')
assert.equal(delta, 1, `an edit costs exactly one request (got ${delta})`)
assert.deepEqual(third.translated, ['index'], 'only the edited artifact is rewritten')
assert.ok(registryAfter.includes('- line 0 of the registry'), 'untouched segments are reused verbatim')
assert.ok(registryAfter.includes('- line 450 was edited'), 'the edited segment is retranslated')
assert.ok(!registryAfter.includes('- line 450 of the registry'), 'the superseded segment is not reused')

// 4. The summary rewrite still marks the pair stale until it is translated.
fs.appendFileSync(path.join(workspace, 'memory_summary.md'), '\nnew consolidation output\n')
assert.equal(currentTranslation(workspace).stale, true, 'rewritten summary marks the translation stale')
const fourth = await translateMemory(ctx, viewDb, paths, config, 'zh')
assert.deepEqual(fourth.translated, ['summary'], 'only the changed artifact is retranslated')
assert.equal(currentTranslation(workspace).stale, false, 'translation is current again')

// 5. Force rebuild ignores the memory and re-translates every segment.
const beforeForce = calls.length
const forced = await translateMemory(ctx, viewDb, paths, config, 'zh', { force: true })
assert.deepEqual(forced.translated.sort(), ['index', 'summary'], 'a forced rebuild rewrites both artifacts')
assert.deepEqual(forced.cached, [], 'a forced rebuild reuses nothing')
assert.ok(calls.length - beforeForce > 10, `forced rebuild re-requests every segment (got ${calls.length - beforeForce})`)

// 6. Switching language reuses the memory but produces the other language file.
const fifth = await translateMemory(ctx, viewDb, paths, config, 'en')
assert.deepEqual(fifth.translated.sort(), ['index', 'summary'], 'a new language translates from scratch')
assert.ok(fs.existsSync(path.join(workspace, 'MEMORY.en.md')), 'english registry written')
assert.ok(!fs.existsSync(path.join(workspace, 'MEMORY.zh.md')), 'zh registry pruned on language switch')

// 7. A removed source prunes its translation instead of leaving an orphan.
fs.rmSync(path.join(workspace, 'MEMORY.md'))
await translateMemory(ctx, viewDb, paths, config, 'en')
assert.ok(!fs.existsSync(path.join(workspace, 'MEMORY.en.md')), 'translation pruned when its source is gone')

// 8. publishMemoryView mirrors the raw texts (the settings writer compresses
//    them into `blobs`; that encoding is covered by the boot smoke).
let published = null
publishMemoryView(viewDb, paths, (view) => { published = view })
assert.ok(published.translatedSummary.startsWith('[zh] v1'), 'translated summary published')
assert.ok(published.summary.startsWith('v1'), 'original summary published')
assert.equal(published.translatedStale, false, 'stale flag published')
assert.ok(published.records.includes('s1'), 'record stats published')

db.close()
console.log('view translation tests passed')
