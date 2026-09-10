import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Dev-only module hooks for running plugin sources under plain Node:
// 1. .md files import as default-exported text (tsdown does this at build time).
// 2. Bare @deepseek-ai/* specifiers resolve to the built harness checkout,
//    mirroring the tsdown aliases in tsdown.config.ts. Without a checkout (CI):
//    dsh-tools falls back to tests/stubs (its npm rc has unpublished peers),
//    everything else resolves from node_modules.
const dsh = process.env.DSH_CHECKOUT ?? 'E:/Arbor/deepseek-harness'
const stub = (name) => pathToFileURL(`${fileURLToPath(new URL('.', import.meta.url))}stubs/${name}.mjs`)
const bareMap = new Map([
  ['@deepseek-ai/cordis', { real: `${dsh}/vendor/cordis/lib/index.js`, fallback: null }],
  ['@deepseek-ai/schemastery', { real: `${dsh}/vendor/schemastery/lib/index.mjs`, fallback: null }],
  ['@deepseek-ai/dsh-tools', { real: `${dsh}/packages/core/tools/lib/index.js`, fallback: stub('dsh-tools') }],
])

export async function resolve(specifier, context, next) {
  const entry = bareMap.get(specifier)
  if (entry) {
    if (existsSync(entry.real)) {
      return { url: pathToFileURL(entry.real).href, shortCircuit: true }
    }
    if (entry.fallback) return { url: entry.fallback.href, shortCircuit: true }
  }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (new URL(url).pathname.endsWith('.md')) {
    const text = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  }
  return next(url, context)
}
