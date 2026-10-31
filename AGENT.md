# AGENT.md

`dsh-remember` is a cross-session long-term memory plugin for dsh.

## Repository layout

```text
src/            host half (cordis plugin, bundled to lib/index.js by tsdown)
  index.ts        wiring: paths, database, memory service, read path,
                  citation loop, scheduler
  config.ts       Schemastery config; all defaults live here
  state.ts        effective config (loader base + ~/.dsh-memory overrides),
                  status and viewer state snapshots
  rpc.ts          the `memory` Host service: config, status, view, commands
  typert.ts       hand-written ./typert manifest (emitted as lib/typert.host.js)
  db.ts           node:sqlite: stage1_outputs / jobs / translation_segments,
                  leases, watermarks, cooldowns, pruning
  transcript.ts   session -> redacted transcript (secret masking + middle truncation)
  phase1.ts       serial scan gate + worker-pool extraction, writes stage-1 rows
  phase2.ts       singleton consolidation job: sync inputs -> git diff ->
                  restricted sub-agent -> record watermark
  workspace.ts    workspace skeleton, file-category contract, rollout files, git baseline
  read-path.ts    systemPrompt.context() summary injection, prefers fresh translations
  citations.ts    parses <dsh-mem-citation>, writes back usage
  scheduler.ts    startup trigger + interval loop, publishes status
  view.ts         view assembly, translation generation (translation memory), meta & pruning
  transfer.ts     memory_export / memory_import and bundle encoding
  llm.ts          one-shot completion wrapper (usage / finish / reasoning counting)
  dsh-types.ts    the host type surface we use; no imports from the checkout
  shims.d.ts      minimal ambient declarations for @deepseek-ai/* and react
  client/         browser half (bundled to lib/client.js): entry, sidebar action,
                  viewer, settings page, citation stripper
tools/shots.mjs   fixtures -> throwaway instance -> headless Chrome/CDP -> docs/shots/*.png
tests/            data layer, import/export, translation memory, startup smoke
docs/shots/       screenshots referenced by the README
```

## Commands

```sh
pnpm build        # tsdown: lib/index.js (host, self-contained) + lib/client.js (react external)
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test tests/*.test.mjs
pnpm shots        # regenerate docs/shots/*.png

node --import ./tests/register-hooks.mjs tests/view.test.mjs   # run a single test

# Live loading: run from the dsh checkout root, patch pointing at this repo's cordis.dev.yml
node --import tsx/esm apps/cli/src/bin.ts web --patch <path/to>/cordis.dev.yml
```

`register-hooks` reproduces two things tsdown does at build time: importing `.md` as text, and resolving `@deepseek-ai/*` to the built checkout (path from `DSH_CHECKOUT`). `--patch` must come before `--port`.

## Release

Bump `version` in package.json, push, then `gh release create vX.Y.Z`. The `publish.yml` workflow (npm trusted publisher, OIDC — no tokens) verifies the tree and stages the package; approve the staged version on npmjs.com (2FA) to make it live.

## Conventions

- **The two halves talk through one Host remote service: `memory`.** The host `ctx.provide('memory', service)` with the service object branded `typertRemote = {service, serviceKey: 'memory', namespace: 'memory'}`; the browser half mounts its own contribution with `ctx.remote.$mount(...)` and then reads `ctx.get('remote.memory')`. The manifest in `src/typert.ts` is hand-written and must stay identical to `CONTRIBUTION` in `src/client/remote.ts` (method names, parameter wires, result shape); `package.json` exports it as `./typert` so the typert loader finds it, and the loader only reads the Host face.
- **A new remote method is four edits.** Host service in `src/rpc.ts`, its strict codec + descriptor in `src/typert.ts`, the matching descriptor in `src/client/remote.ts`, and the client call site.
- **A missing wire field is not `undefined`.** The gateway JSON-checks the parsed value, so an own `undefined` property fails the call; omit absent optional fields instead.
- **Registration is an effect.** All contributions go through `ctx.effect()` / `ctx.on()`; disposers returned by registrations belong to the effect.
- **Changing a config field means touching three places.** The schema in `src/config.ts` together with `MemoryPluginConfig`, the settings-page field groups (`FIELD_SPECS` in `memory-card.ts`), and the zh/en copy in `src/client/index.ts` (`field_*` / `hint_*`) must be updated together.
- **No compatibility layers.** Historical formats (uncompressed JSON, directory bundles, old translation file names) are handled only on import paths; internal data structures get no legacy branches.
- **Translations are a cache.** `translation_segments` hits are reused; `force` rebuilds everything; switching languages means deleting the other languages' files and meta. Any "retranslate while at it" is a bug.
- **`memory_summary.md` is not the source of truth.** The index is `MEMORY.md`, evidence is `rollout_summaries/`; the summary is just the injected head.
- **The consolidator's allowlist is enforced at execution time only.** Intercept with `tools/pre-execute`, not `tools.restrict()`: tools from scoped presets bypass the latter, and it reports unknown tool when setup runs before mount.
- **Singleton jobs carry a lease.** Phase 2 is a global singleton; new job types follow `tryClaimPhase2Job`'s lease + heartbeat pattern, never an in-process flag.
- **Unsourced claims are marked as such.** Conclusions in memory content must point back to rollout evidence; if they can't, write the gap — don't guess.
- **Comments state local facts only.** No restating the code, no change history; behavior, failure modes, timing, ownership — things the code can't tell you — are what's worth writing.
- **Files end with exactly one newline.**

## Client UI

- **Slot hooks are framework-synthesized `use<Name>`.** Register with `inject: () => ({ hooks: { memoryStatus: source } })`, consume via `props.useMemoryStatus(selector)`; `props.hooks.x` does not exist.
- **Use real theme tokens only** (`--dsw-alias-*`). A wrong token name doesn't error — text just goes white or invisible. Common ones: `label-primary/-secondary/-tertiary`, `bg-layer-1/2/3`, `border-l1..l4`, `fill-tertiary`, `brand-primary`, `interactive-bg-hover`, `button-info-fill/-hover`, `label-primary-foreground`, `state-{success,warn,error}-primary`.
- **The browser bundle externalizes only `react`.** The host's `@deepseek-ai/dsh-client-ui-*` can't be reached; inline icons and controls to the same spec (see `MemoryIcon` and `.dshm-switch` in `sidebar-action.ts`, specs from `ui-primitives`' `IconDatabaseOutline16` and `Switch.module.css`).
- **Product copy goes through locale.** New strings go into the `ZH` / `EN` dictionaries in `src/client/index.ts`; no hardcoded Chinese in components.
- **The sidebar-bottom entry aligns with "Settings".** 42px row, `padding: 0 10px 0 8px`, `gap: 8`, `border-radius: 12`; wide rail `width: calc(100% + 4px); margin: 4px -2px`, collapsed rail 36×36 circle. Read `ui-settings-general`'s `SettingsRoot.module.css` before changing.
- **Overlays use `position: fixed` with measured coordinates.** The sidebar clips overflow; anything in document flow gets cut off. Reference: `ui-cordis`' `CordisPanel`.
- **Switch state lives on `aria-checked`** — do not add a separate `data-on`, or paint and assistive tech may read different states.

## Testing

- Run `pnpm test` when touching the data layer, import/export, or the translation cache; skip it for doc/comment-only changes.
- After host-side behavior changes, `pnpm build` then smoke a throwaway instance with `--port 0 --no-open`; shut it down when done.
- **Never stop or occupy the dsh instance (or its port) that hosts the current session.**
- The verification path for frontend changes is `pnpm shots`: it captures the real UI, proving components render and alignment hasn't drifted.
- Tests describe behavior, not correctness; when behavior changes, change the test — never bend behavior to keep a test green.
