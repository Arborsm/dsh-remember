# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/). Release artifacts: [GitHub Releases](https://github.com/Arborsm/dsh-remember/releases).

## [0.3.0] - 2026-10-31

### Added

- Plugin-page registration (`plugins.bundle.config`) so the memory page opens from Plugins → dsh-remember, next to the existing settings section
- `icon.svg` and `locale/{en,zh}.json` plugin metadata: the plugin manager shows the localized title and one-line description on the card and page

### Changed

- Requires dsh `>=0.2.0-rc.1 <0.3.0-0` (`engines.dsh`); the 0.1.x settings-provider API is gone
- Host and browser halves now talk over a single `memory` remote service exposed through a hand-written `./typert` manifest and mounted with `ctx.remote.$mount`; the removed `memory-status` / `memory-commands` / `memory-view` settings namespaces are gone
- Settings-page edits persist to `~/.dsh-memory/config.json` as overrides on the loader config, instead of rewriting the profile patch
- Export returns the bundle over the remote call and the browser saves it with the same file-picker flow
- Activation looks `remote.session` up through `ctx.get` and downgrades gracefully when the model catalog is unavailable, so an optional client service can never abort web boot
- Phase-1/phase-2 sub-agent messages use the v4 producer-owned source kind `dsh-remember`; `plugin` is rejected by session format v4

### Removed

- `src/settings.ts` (settings provider surface and the four namespaces)

## [0.2.0] - 2026-09-11

### Changed

- Renamed the project and npm package to `dsh-remember`
- Viewer: records tab merged into the overview (searchable table, most-cited top 5, registry size card); the overview no longer duplicates the summary text
- Settings: import/export use the native file picker / save dialog instead of typed paths
- Bundle extension is now plain `.dshmem`

### Added

- CI workflow (build / typecheck / test)
- npm trusted-publisher pipeline (OIDC, staged publishing) — releases stage automatically, approved on npmjs.com

## [0.1.0] - 2026-09-10

First public release: background extraction from idle sessions, incremental consolidation into a plain-Markdown memory workspace, summary injection on every prompt, citation feedback loop, one-click translation with segment caching, gzip bundle export/import, sidebar status panel, memory viewer, and a settings page.

[0.3.0]: https://github.com/Arborsm/dsh-remember/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Arborsm/dsh-remember/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Arborsm/dsh-remember/releases/tag/v0.1.0
