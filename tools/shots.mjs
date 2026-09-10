/**
 * Screenshot harness: builds a throwaway memory workspace (fixture content, no
 * real session data), boots a throwaway `dsh web` against it through the dev
 * overlay, drives the real UI over CDP in headless Chrome, and writes clipped
 * PNGs of this plugin's own surfaces into `docs/shots/`.
 *
 *   node --import ./tests/register-hooks.mjs tools/shots.mjs [--keep]
 *
 * The clipping is deliberate: the rest of the frame belongs to the user's real
 * sessions, so each shot captures only the memory surfaces (plus the sidebar
 * foot around them, which is what the alignment is about).
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { MemoryDatabase } from '../src/db.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const plugin = path.resolve(here, '..')
const dsh = process.env.DSH_CHECKOUT ?? 'E:/Arbor/deepseek-harness'
const shotsDir = path.join(plugin, 'docs', 'shots')
const workDir = path.join(here, '.shots')
const fixtureRoot = path.join(workDir, 'memories')
const fixtureDb = path.join(workDir, 'memories.sqlite')
const keep = process.argv.includes('--keep')

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
].find((candidate) => fs.existsSync(candidate))

// ── fixture ─────────────────────────────────────────────────────────────────

const SUMMARY = `v1

## 用户画像
- 林舟 —— 中文开发者，Windows (pwsh)，主力项目 Anvil Studio（Tauri + React）
- 极简交互偏好：一句话授权即执行，不要选项菜单，不要成本/风险前言
- 对过度工程化敏感：抽象能在脑子里跑完才准留下

## 用户偏好
- 验证要相称：改动只在树里、只剩格式差异时不跑全量测试
- 交付物不达预期（"没什么用"）时直接删掉，不要劝说

## 记忆内容

### E:\\Arbor\\Anvil Studio

#### 2026-03-02
- host-command 架构落地：172 个命令走 #[host_command] proc-macro + 生成器
- build.rs 漂移门禁：新增命令后必须重跑 gen:host-commands，否则 --check 退出 1
- mutation 命令必须声明 resources(...)，否则 sidecar 路由不注入句柄

#### 2026-02-27
- Windows 预提交链：husky → lint-staged → sh -c cargo fmt 在本机没有 sh
- 修复办法是只对暂存文件跑 rustfmt 的 Node wrapper，注意 lint-staged 会追加路径
`

const REGISTRY = `# Memory Registry

- version: v1
- updated: 2026-03-02

## E:\\Arbor\\Anvil Studio

### 架构
- [host-command-macro] 172 个命令的绑定源头在 commands.rs，生成器读它产出 invoke 表 · usage 14
- [build-drift-gate] build.rs --check 与 gen:host-commands 成对；改路径规则要同步 renderGeneratedRustInvokeHandler · usage 9
- [resource-variants] mutation 命令必须声明 resources(...)，否则 sidecar 不注入句柄 · usage 6
- [two-layer-runtime] host_runtime.rs 折叠为两层，中间层已删除 · usage 4

### 工具链
- [windows-hooks] husky → lint-staged → sh 缺失；用仅暂存的 rustfmt wrapper，编辑后要重新 add · usage 7
- [crlf] 行尾空白会被 pre-commit 拒绝；git reset --soft 可把 3 个提交压成 1 个 · usage 3

### 偏好
- [minimal-abstraction] 抽象先能在脑子里跑完；不满足就退化掉 · usage 11
- [proportional-checks] 只跑了格式化的改动不要触发全量验证 · usage 8

## E:\\Arbor\\dsh-memory

### 插件
- [dsh-remember] 两阶段记忆系统；提取并发默认 1，整理作业带租约 · usage 12
- [translation-memory] 按 ~1KB 分段做译文缓存，改一行只重翻一段 · usage 5
`

const ROWS = [
  {
    sessionId: '2026-03-02T09-14-22-a1b2',
    workspacePath: 'E:\\Arbor\\Anvil Studio',
    rolloutSlug: 'host-command-macro-refactor',
    rawMemory: '- 172 个命令全部走 #[host_command]\n- 生成器是唯一事实来源\n',
    rolloutSummary: '把 172 个命令的绑定统一到 proc-macro 与生成器，并加漂移门禁。',
    generatedAt: daysAgo(0.2),
    sourceUpdatedAt: daysAgo(0.3),
    usageCount: 14,
    lastUsage: daysAgo(0.1),
    selectedForPhase2: true,
  },
  {
    sessionId: '2026-03-01T18-02-05-c3d4',
    workspacePath: 'E:\\Arbor\\dsh-memory',
    rolloutSlug: 'translation-memory-segments',
    rawMemory: '- 译文缓存按段做，改一行只重翻一段\n- 强制作废走 secondary 确认\n',
    rolloutSummary: '给记忆译文加分段缓存与强制重建。',
    generatedAt: daysAgo(1.1),
    sourceUpdatedAt: daysAgo(1.2),
    usageCount: 5,
    lastUsage: daysAgo(0.6),
    selectedForPhase2: true,
  },
  {
    sessionId: '2026-02-27T14-41-09-e5f6',
    workspacePath: 'E:\\Arbor\\Anvil Studio',
    rolloutSlug: 'windows-precommit-chain',
    rawMemory: '- husky 在本机找不到 sh\n- 只对暂存文件跑 rustfmt\n',
    rolloutSummary: '修好 Windows 上 commit 不了的预提交链。',
    generatedAt: daysAgo(3.4),
    sourceUpdatedAt: daysAgo(3.5),
    usageCount: 7,
    lastUsage: daysAgo(2.2),
    selectedForPhase2: true,
  },
  {
    sessionId: '2026-02-25T08-30-51-1122',
    workspacePath: 'E:\\Arbor\\Anvil Studio',
    rolloutSlug: 'sidecar-resource-handles',
    rawMemory: '- mutation 命令声明 resources(...)\n',
    rolloutSummary: 'sidecar 路由的句柄注入条件。',
    generatedAt: daysAgo(5.7),
    sourceUpdatedAt: daysAgo(5.8),
    usageCount: 6,
    lastUsage: daysAgo(4.9),
    selectedForPhase2: true,
  },
  {
    sessionId: '2026-02-22T21-07-33-3344',
    workspacePath: 'E:\\Arbor\\dsh-memory',
    rolloutSlug: 'phase1-concurrency-port',
    rawMemory: '- phase1_max_concurrency 默认 1，clamp 到 16\n',
    rolloutSummary: '核对提取并发与保留参数在配置里的默认值。',
    generatedAt: daysAgo(8.2),
    sourceUpdatedAt: daysAgo(8.3),
    usageCount: 12,
    lastUsage: daysAgo(6.5),
    selectedForPhase2: false,
  },
  {
    sessionId: '2026-02-20T11-55-02-5566',
    workspacePath: 'E:\\Arbor\\DeterminFlow',
    rolloutSlug: 'plugin-system-landing-doc',
    rawMemory: '- docs/design/compat-plugin-system-landing.md\n',
    rolloutSummary: '插件系统落地文档的目录结构。',
    generatedAt: daysAgo(10.6),
    sourceUpdatedAt: daysAgo(10.7),
    usageCount: 2,
    lastUsage: null,
    selectedForPhase2: false,
  },
]

function daysAgo(days) {
  return Math.floor(Date.now() / 1000 - days * 86400)
}

function seedFixture() {
  remove(workDir)
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fs.writeFileSync(path.join(fixtureRoot, 'memory_summary.md'), SUMMARY)
  fs.writeFileSync(path.join(fixtureRoot, 'MEMORY.md'), REGISTRY)
  const db = new MemoryDatabase(fixtureDb)
  for (const row of ROWS) {
    db.upsertStage1({
      rolloutPath: path.join(os.tmpdir(), 'rollouts', `${row.sessionId}.jsonl`),
      rolloutSlug: row.rolloutSlug,
      selectedForPhase2SourceUpdatedAt: row.selectedForPhase2 ? row.sourceUpdatedAt : null,
      ...row,
    }, true)
  }
  db.close()
  const overlay = path.join(workDir, 'cordis.shots.yml')
  fs.writeFileSync(overlay, [
    '# Generated by tools/shots.mjs — screenshot capture only.',
    '- insert:',
    '    - id: dsh-memory',
    `      name: '${path.join(plugin, 'lib', 'index.js').replaceAll('\\', '/')}'`,
    '      config:',
    '        enabled: true',
    '        # No LLM work during capture: the fixture is the whole dataset.',
    '        generateMemories: false',
    '        useMemories: false',
    '        runPhase2OnStartup: false',
    `        workspaceDir: '${fixtureRoot.replaceAll('\\', '/')}'`,
    `        dbPath: '${fixtureDb.replaceAll('\\', '/')}'`,
    '',
  ].join('\n'))
  return overlay
}

// ── processes ───────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function startHost(overlay, port) {
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
    '--patch', overlay, '--port', String(port), '--no-open',
  ], { cwd: dsh, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (chunk) => { log += String(chunk) })
  child.stderr.on('data', (chunk) => { log += String(chunk) })
  const match = await waitFor(() => /(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(log)?.[1], 60_000, 'dsh web URL')
  return { child, url: match }
}

async function startChrome(profileBase) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const port = await freePort()
    const profile = `${profileBase}-${attempt}`
    const child = spawn(CHROME, [
      '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars',
      '--window-size=1600,1000', 'about:blank',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stderr.on('data', (chunk) => { log += String(chunk) })
    try {
      const version = await waitFor(async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${port}/json/version`)
          return response.ok ? await response.json() : null
        } catch {
          return null
        }
      }, 25_000, `chrome devtools${log === '' ? '' : ` (${log.trim().slice(-200)})`}`)
      return { child, version, port, profile }
    } catch (error) {
      // The launcher sometimes hands off and dies before binding; sweep and retry.
      killTree(child.pid)
      killByCommandLine(path.basename(profile))
      remove(profile)
      if (attempt === 3) throw error
      console.log('  ! headless chrome did not bind devtools; retrying')
    }
  }
  throw new Error('unreachable')
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(150)
  }
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

// ── CDP ─────────────────────────────────────────────────────────────────────

async function attach(devtoolsPort) {
  const targets = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)).json()
  const target = targets.find((entry) => entry.type === 'page')
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    const entry = pending.get(message.id)
    if (entry == null) return
    pending.delete(message.id)
    if (message.error) entry.reject(new Error(`${message.error.message} (${entry.method})`))
    else entry.resolve(message.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject, method })
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed')
    return result.result.value
  }
  return { send, evaluate, close: () => socket.close() }
}

/** Screenshot the union of the elements an expression yields, at 2x. */
async function shot(cdp, name, elementsExpr, pad = 10) {
  // Freeze motion: a pulse caught mid-cycle renders washed out.
  await cdp.evaluate(`(() => {
    let tag = document.querySelector('style[data-dsh-shots-freeze]')
    if (tag == null) {
      tag = document.createElement('style')
      tag.dataset.dshShotsFreeze = 'true'
      tag.textContent = '*, *::before, *::after { animation: none !important; transition: none !important; }'
      document.head.appendChild(tag)
    }
  })()`)
  const rect = await cdp.evaluate(`(() => {
    const boxes = (${elementsExpr}).filter(Boolean).map((node) => node.getBoundingClientRect())
    if (boxes.length === 0) return null
    const left = Math.min(...boxes.map((b) => b.left))
    const top = Math.min(...boxes.map((b) => b.top))
    const right = Math.max(...boxes.map((b) => b.right))
    const bottom = Math.max(...boxes.map((b) => b.bottom))
    return { x: left, y: top, width: right - left, height: bottom - top }
  })()`)
  if (rect == null) throw new Error(`nothing to capture for ${name}`)
  const clip = {
    x: Math.max(0, Math.round(rect.x - pad)),
    y: Math.max(0, Math.round(rect.y - pad)),
    width: Math.round(rect.width + pad * 2),
    height: Math.round(rect.height + pad * 2),
    scale: 1,
  }
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: true })
  const file = path.join(shotsDir, `${name}.png`)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`  ${name}.png  ${clip.width}x${clip.height} css px`)
}

// ── capture ─────────────────────────────────────────────────────────────────

async function main() {
  if (CHROME == null) throw new Error('no Chrome/Edge binary found for capture')
  // Drop stale frames so a renamed shot never leaves an orphan behind.
  for (const name of fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : []) {
    if (name.endsWith('.png')) fs.rmSync(path.join(shotsDir, name))
  }
  fs.mkdirSync(shotsDir, { recursive: true })
  console.log('• seeding fixture…')
  const overlay = seedFixture()

  const port = await freePort()
  const profileBase = path.join(workDir, `chrome-${process.pid}`)
  console.log(`• booting dsh web (:${port}) and headless chrome…`)
  const host = await startHost(overlay, port)
  const chrome = await startChrome(profileBase)
  const cdp = await attach(chrome.port)

  try {
    await cdp.send('Page.enable')
    await cdp.send('Runtime.enable')
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false,
    })
    await cdp.send('Page.navigate', { url: host.url })
    console.log('• waiting for the memory entry…')
    await cdp.evaluate(`new Promise((resolve) => {
      const deadline = Date.now() + 60000
      const tick = () => {
        if (document.querySelector('.dshm-layer') != null) return resolve(true)
        if (Date.now() > deadline) return resolve(false)
        setTimeout(tick, 200)
      }
      tick()
    })`).then((found) => { if (!found) throw new Error('the memory footer entry never rendered') })

    // The viewer lives in the right sidebar, which only exists inside a session
    // view; start an empty one when the frame opens on the landing state.
    await closeOverlays(cdp)
    if (!await cdp.evaluate(`document.querySelector('[class*="panelBody"]') != null`)) {
      const started = await cdp.evaluate(`(() => {
        const node = document.querySelector('[class*="newSession"]')
        if (node == null) return false
        node.click()
        return true
      })()`)
      if (!started) console.log('  ! no new-session control found; continuing on the landing frame')
      await sleep(1200)
      await closeOverlays(cdp)
    }

    // CSS-module class names are hashed, so match them by substring.
    console.log('• capturing…')
    // Let the startup scan settle so the shots show the resting state.
    await cdp.evaluate(`new Promise((resolve) => {
      const deadline = Date.now() + 20000
      const tick = () => {
        const busy = document.querySelector('.dshm-foot-state[data-active="true"]') != null
        if (!busy || Date.now() > deadline) return resolve(!busy)
        setTimeout(tick, 250)
      }
      tick()
    })`)
    if (process.argv.includes('--debug')) console.log('  geometry:', JSON.stringify(await cdp.evaluate(`(() => {
      const rect = (node) => node == null ? null : (({ top, bottom, left, width, height }) => ({ top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), width: Math.round(width), height: Math.round(height) }))(node.getBoundingClientRect())
      const foot = document.querySelector('[class*="footArea"]')
      return {
        footArea: rect(foot),
        footerActions: rect(foot?.firstElementChild),
        layer: rect(document.querySelector('.dshm-layer')),
        settings: rect(foot?.lastElementChild),
        settingsRow: rect(foot?.lastElementChild?.firstElementChild),
      }
    })()`)))
    // One frame for the whole sidebar story: the open panel above, the entry
    // row and the Settings row it aligns with below.
    await cdp.evaluate(`document.querySelector('.dshm-foot').click()`)
    await waitFor(() => cdp.evaluate(`document.querySelector('.dshm-panel') != null`), 5_000, 'the footer panel')
    await shot(cdp, '01-sidebar-panel',
      `[document.querySelector('[class*="footArea"]'), document.querySelector('.dshm-panel')]`, 12)

    await cdp.evaluate(`(() => {
      const button = [...document.querySelectorAll('.dshm-panel button')]
        .find((node) => node.textContent === '查看记忆')
      if (button == null) throw new Error('the viewer action is missing')
      button.click()
    })()`)
    try {
      await waitFor(() => cdp.evaluate(`document.querySelector('.dshmv-root') != null`), 10_000, 'the viewer pane')
    } catch (error) {
      console.log('  ! viewer diagnostics:', JSON.stringify(await cdp.evaluate(`({
        panes: document.querySelectorAll('[class*="panelBody"]').length,
        dialogs: document.querySelectorAll('[role="dialog"]').length,
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      })`)))
      throw error
    }
    await sleep(400)
    const paneClip = `[document.querySelector('[class*="panelBody"]')?.parentElement ?? document.querySelector('.dshmv-root')]`
    // Every pane is the same box, so the four tab shots tile evenly.
    for (const [name, tab] of [['02-viewer-overview', null], ['03-viewer-summary', '摘要'], ['04-viewer-index', '注册表'], ['05-viewer-records', '记录']]) {
      if (tab != null) {
        await cdp.evaluate(`(() => {
          const node = [...document.querySelectorAll('.dshmv-tab')].find((entry) => entry.textContent === '${tab}')
          if (node == null) throw new Error('missing tab ${tab}')
          node.click()
        })()`)
        await sleep(300)
      }
      await shot(cdp, name, paneClip, 1)
    }
  } finally {
    cdp.close()
    killTree(chrome.child.pid)
    // Chrome relaunches itself as a detached process, so the tree kill usually
    // misses the real browser; sweep by the unique profile name too.
    killByCommandLine(path.basename(chrome.profile))
    killTree(host.child.pid)
    await sleep(1200)
    remove(chrome.profile)
    if (!keep) remove(workDir)
  }
  console.log(`• wrote ${fs.readdirSync(shotsDir).length} shots to docs/shots`)
}

/** Sweep processes whose command line carries a unique marker (chrome.exe). */
function killByCommandLine(marker) {
  const script = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"`
    + ` | Where-Object { $_.CommandLine -like '*${marker}*' }`
    + ' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'
  try {
    spawnSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' })
  } catch {
    // nothing to sweep
  }
}

/** Browser and host both fork helpers; take the whole tree down. */
function killTree(pid) {
  if (pid == null) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // process already gone
  }
}

/** Dismiss an onboarding/approval overlay that would cover the frame. */async function closeOverlays(cdp) {
  for (const type of ['keyDown', 'keyUp']) {
    await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  }
  await sleep(250)
}

/** Chrome keeps its profile locked for a moment after exit. */
function remove(target) {  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      return
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)
    }
  }
}

await main()
