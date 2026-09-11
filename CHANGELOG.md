# Changelog

All notable changes to this project are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions follow [SemVer](https://semver.org/). Release artifacts: [GitHub Releases](https://github.com/Arborsm/dsh-remember/releases).

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

[0.2.0]: https://github.com/Arborsm/dsh-remember/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Arborsm/dsh-remember/releases/tag/v0.1.0
