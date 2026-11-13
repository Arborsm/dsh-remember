/**
 * Host half of dsh-remember: one plugin entry that owns the memory database,
 * the background scheduler, the prompt read path, and the `memory` remote
 * service the browser half talks to.
 */

import { MemoryDatabase } from './db.ts'
import type { DshContext } from './dsh-types.ts'
import { resolveMemoryPaths, type MemoryPaths } from './paths.ts'
import { Config, type MemoryPluginConfig } from './config.ts'
import { registerCitationLoop } from './citations.ts'
import { registerReadPath } from './read-path.ts'
import { createMemoryService } from './rpc.ts'
import { startScheduler, type SchedulerHandle } from './scheduler.ts'
import { MemoryState } from './state.ts'
import { registerTransferTools } from './transfer.ts'
import { publishMemoryView } from './view.ts'

export const name = 'dsh-remember'

export const inject = [
  'tools',
  'llm',
  'systemPrompt',
  'agents',
  'sessionPersistence',
  'agentDefaultModel',
]

export { Config }

export function apply(ctx: DshContext, config: MemoryPluginConfig): void {
  const paths: MemoryPaths = resolveMemoryPaths(config)
  const db = new MemoryDatabase(paths.dbPath)
  ctx.effect(() => () => db[Symbol.dispose]())

  // Loader config is the base layer; the web UI's edits persist as overrides
  // and are merged into the same object every component below closes over.
  const state = new MemoryState(config)

  console.info(
    `[dsh-memory] loaded: workspace=${paths.workspaceRoot} db=${paths.dbPath}`
      + ` generate=${config.generateMemories} use=${config.useMemories}`,
  )

  if (!config.enabled) {
    console.info('[dsh-memory] disabled by config; nothing registered')
    return
  }

  const refreshView = (): void => {
    try {
      publishMemoryView(db, paths, config, state.writeView)
    } catch (error) {
      console.warn('[dsh-memory] view publish failed:', error)
    }
  }

  let schedulerHandle: SchedulerHandle | null = null
  // The service is the single browser entry point: config, status, viewer
  // data, and every user action. `./typert` describes it for the gateway.
  const service = createMemoryService({
    ctx,
    db,
    paths,
    config,
    state,
    requestCycle: (force?: boolean) => schedulerHandle?.requestCycle(force),
  })
  if (typeof ctx.provide === 'function') {
    ctx.provide('memory', service)
  } else {
    console.warn('[dsh-memory] ctx.provide is unavailable; the web half cannot reach the host')
  }

  if (config.useMemories) {
    registerReadPath(ctx, paths, config)
  }

  registerCitationLoop(ctx, db)
  registerTransferTools(ctx.tools, db, paths, () => schedulerHandle?.requestCycle(true))
  schedulerHandle = startScheduler(ctx, db, paths, config, state.writeStatus, {
    lastCycleAt: null,
    lastError: null,
    onCycleEnd: refreshView,
  })
  refreshView()
}
