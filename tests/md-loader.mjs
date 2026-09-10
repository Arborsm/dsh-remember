import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** Dev-only loader: import .md files as default-exported text (tsdown does
 * the same at build time via its `loader: { '.md': 'text' }` mapping). */
export async function load(url, context, next) {
  if (new URL(url).pathname.endsWith('.md')) {
    const text = await readFile(fileURLToPath(url), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  }
  return next(url, context)
}
