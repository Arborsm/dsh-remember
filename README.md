# dsh-remember

[![ci](https://github.com/Arborsm/dsh-remember/actions/workflows/ci.yml/badge.svg)](https://github.com/Arborsm/dsh-remember/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-remember)](https://www.npmjs.com/package/dsh-remember)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[中文](README.zh-CN.md)

Cross-session long-term memory for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh).

While you're away, it looks back at your recent sessions and distills the useful experience into a set of plain Markdown files. Every conversation after that starts with a summary of those memories, and the model greps the originals when it needs details.

No vector database, no external service — memories are just files under `~/.dsh-memory/` that you can open, search, and manage with git.

## Features

- **Automatic extraction** — idle sessions are scanned, redacted, and distilled in the background
- **Automatic consolidation** — new experience is merged incrementally; stale, never-cited entries are pruned
- **Automatic recall** — every prompt carries a memory summary (configurable token cap); the model searches on demand
- **Readable and controllable** — a sidebar status panel, a memory viewer, and a settings page; pause anytime
- **Translatable** — one-click translation of the memory files with incremental caching
- **Portable** — gzip bundle export/import with content-hash dedup

## Screenshots

The memory entry at the bottom of the sidebar opens the status panel.

<p align="center">
  <img src="docs/shots/01-sidebar-panel.png" width="420" alt="Sidebar entry and status panel">
</p>

The memory viewer: overview, summary, index, and records.

<p align="center">
  <img src="docs/shots/02-viewer-overview.png" width="330" alt="Overview">
  <img src="docs/shots/03-viewer-summary.png" width="330" alt="Summary">
</p>

<p align="center">
  <img src="docs/shots/04-viewer-index.png" width="330" alt="Index">
  <img src="docs/shots/05-viewer-records.png" width="330" alt="Records">
</p>

## Install

From npm:

```sh
dsh plugin --profile <name> add dsh-remember
```

From source:

```sh
git clone https://github.com/Arborsm/dsh-remember.git
cd dsh-remember
pnpm install && pnpm build
dsh plugin --profile <name> add .
```

Restart `dsh web` after installing. During development you can skip installation and load straight from the workspace (run from the dsh checkout root):

```sh
pnpm dsh web --patch <path/to>/dsh-remember/cordis.dev.yml
```

Note: `--patch` must come before `--port`, otherwise commander fails with `unknown option '--patch'`.

## Configuration

Every field has a default; the plugin works out of the box. Override via `cordis.yml` or the `config:` block of a dev overlay. Field definitions live in `src/config.ts`.

Commonly tuned:

| Field | Default | Description |
|---|---|---|
| `enabled` | `true` | Master switch |
| `generateMemories` | `true` | Run extraction and consolidation |
| `useMemories` | `true` | Inject the memory summary into prompts |
| `extractModel` / `consolidationModel` | `''` | `provider/model`; empty = deployment default |
| `workspaceDir` / `dbPath` | `''` | Empty = under `~/.dsh-memory/` |
| `summaryTokenLimit` | `2500` | Token cap for the injected summary |
| `scanIntervalMinutes` | `15` | Background scan interval |
| `minRolloutIdleHours` | `1` | Idle time before a session becomes extractable |
| `maxUnusedDays` | `30` | Retention for never-cited memories |

There are 23 fields in total (scheduling, retries, concurrency, consolidator tool deny-list, …) — see `src/config.ts`. All of them are editable on the settings page.

## Memory files

```text
~/.dsh-memory/
├── memories/                  # git workspace
│   ├── MEMORY.md              # index of all memories
│   ├── memory_summary.md      # the summary injected into prompts
│   ├── rollout_summaries/     # source evidence for each memory
│   ├── skills/                # distilled skills
│   └── …                      # translations, ad-hoc notes, …
└── memories.sqlite            # extraction queue and job state
```

## Development

```sh
pnpm build        # build (tsdown, host + browser bundles)
pnpm typecheck    # tsc --noEmit
pnpm test         # node --test
pnpm shots        # regenerate the screenshots above (fixtures + headless Chrome)
```

Repository layout, conventions, and debugging notes: [AGENT.md](AGENT.md).
