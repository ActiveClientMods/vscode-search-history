# Change Log

All notable changes to the **Search History Explorer** extension are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-07-22

### Added

- **Search History** view in the Activity Bar, backed by VS Code's native `Memento` storage (see the README's _Architecture_ section for the SQLite vs. `Memento` evaluation).
- **New Search & Save** flow with native-search-style inline toggles for Regex, Match Case and Whole Word — active toggles are tinted and their on/off state is echoed live in the prompt — plus optional include/exclude glob steps.
- One-click re-run of any entry via `workbench.action.findInFiles`, pre-filling the exact query, flags and paths.
- **Folders** for grouping topic-related searches, either **global** (across workspaces) or **workspace-specific**; entries can be **dragged** into folders or moved via _Move to Folder…_, with create/rename/delete support.
- **Filter & Sort** dropdown menu in the title bar (replacing the bare filter input) with text/regex filtering, filter-by-tag, favorites-only toggle and clear.
- History filtering with optional **regex** support, matching queries, tags, workspace names and glob patterns; invalid regex is surfaced inline.
- **Tags** and **Favorites**, with an inline ⭐ toggle (outline ↔ filled) on each row; favorites are pinned to the top and protected from automatic pruning.
- **Global** vs **Workspace** scope toggle in the view title bar.
- Automatic de-duplication of identical searches (usage count + last-used tracking), configurable via `searchHistory.deduplicate`.
- Configurable retention cap via `searchHistory.maxEntries`.
- Unit tests for the storage and filtering layers and an integration test for activation and command registration.
- CI workflow (Bun + oxlint + headless VS Code tests via `xvfb-run`).

### Tooling

- Migrated all package management and scripts to **Bun** / **bunx**.
- Replaced ESLint / typescript-eslint with **oxlint**.
- Pinned TypeScript to `7.0.2`.

[1.0.0]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.0.0
