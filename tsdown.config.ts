import path from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

// Host half: every @deepseek-ai runtime dependency is bundled into
// lib/index.js so the built file is self-contained — it loads via
// `pnpm dsh web --patch` (dev) and `dsh plugin add` (bundle) without any
// node_modules of its own. Dependencies resolve against a built
// deepseek-harness checkout.
const dsh = process.env.DSH_CHECKOUT ?? 'E:/Arbor/deepseek-harness'

const vendor = (name: string) => path.posix.join(dsh, 'vendor', name, 'lib')
const pkg = (group: string, name: string) => path.posix.join(dsh, 'packages', group, name, 'lib')

const host: UserConfig = {
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  dts: false,
  loader: { '.md': 'text' },
  alias: {
    '@deepseek-ai/cordis': `${vendor('cordis')}/index.js`,
    '@deepseek-ai/schemastery': `${vendor('schemastery')}/index.mjs`,
    '@deepseek-ai/dsh-tools': `${pkg('core', 'tools')}/index.js`,
  },
  external: [/^node:/],
}

// Browser half (lib/client.js): a closure-factory CJS artifact handshaking
// with the client module system (`window.__ModuleLoader__.load`). The module
// table answers every bare import — only react here — everything else inlines.
const client: UserConfig = {
  name: 'dsh-memory-plugin/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [/^react(\/|$)/],
  inputOptions: {
    resolve: {
      conditionNames: ['production', 'browser', 'import', 'module', 'default'],
    },
  },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-memory-plugin", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
