import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

// Dev-only module hooks for running plugin sources under plain Node:
// 1. .md files import as default-exported text (tsdown does this at build time).
// 2. Bare @deepseek-ai/* specifiers resolve to the built harness checkout,
//    mirroring the tsdown aliases in tsdown.config.ts.
const dsh = process.env.DSH_CHECKOUT ?? 'E:/Arbor/deepseek-harness'
const bareMap = new Map([
  ['@deepseek-ai/cordis', pathToFileURL(`${dsh}/vendor/cordis/lib/index.js`)],
  ['@deepseek-ai/schemastery', pathToFileURL(`${dsh}/vendor/schemastery/lib/index.mjs`)],
  ['@deepseek-ai/dsh-tools', pathToFileURL(`${dsh}/packages/core/tools/lib/index.js`)],
])

export async function resolve(specifier, context, next) {
  const mapped = bareMap.get(specifier)
  if (mapped) return { url: mapped.href, shortCircuit: true }
  return next(specifier, context)
}

export async function load(url, context, next) {
  if (new URL(url).pathname.endsWith('.md')) {
    const text = await readFile(new URL(url), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  }
  return next(url, context)
}
