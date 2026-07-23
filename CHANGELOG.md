# Change Log

All notable changes to the **Search History Explorer** extension are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.3] - 2026-07-23

### Changed

- **The favorite star is now always visible on every row** and reflects its state — filled and yellow for favorites, a dimmed outline otherwise — so it works as an at-a-glance favorite indicator, not just a hover action. Toggling still happens via the inline star (on hover) or the right-click menu. (VS Code renders a row's inline action buttons only on hover, so the always-visible indicator is the row's leading icon.)
- **The Replace expand/collapse chevron now rotates in place.** Only the chevron glyph rotates when the Replace field opens/closes; the button's hover area no longer rotates with it, so the hover target stays fixed.

### Internal

- **Reorganized the source into concern-based folders** — `core/` (types, storage, filter, workspace), `search/` (engine core, ripgrep/JS backends, dispatcher, native hand-off), `views/` (search-bar webview, tree provider, tree items, formatting) and `commands/` (handlers grouped by concern). The search-bar webview's CSS and client script were extracted from `searchBarView.ts` into `media/searchBar.css` and `media/searchBar.js` (loaded via `asWebviewUri`), roughly halving that file. No functional changes.

## [1.1.2] - 2026-07-23

### Fixed

- **Invalid regular expressions are no longer saved to history.** A search-as-you-type (or manual) run with an invalid regex is shown as an error but is not recorded, so broken patterns never clutter the list. Persisting now happens only after a search runs to completion successfully.
- **The invalid-regex message is cleaner** — a plain "Invalid regular expression" instead of ripgrep's raw, colon-terminated `rg: regex parse error:` line.
- **The favorite state is no longer shown twice.** Toggling a favorite updated both the inline star on the right and the row's leading icon; the row icon now stays a plain search glyph, leaving a single favorite indicator on the right.

### Changed

- **Typing suggestions are now opt-in** via the new `searchHistory.showSuggestions` setting (default **off**). Previously the dropdown of past searches appeared on focus/typing and could overlap the Replace and include/exclude fields.

## [1.1.1] - 2026-07-23

### Changed

- **Search as you type now saves automatically.** When `searchHistory.searchOnType` is enabled, each query you pause on (after the debounce) is recorded to history without any extra step — previously the live search ran but was only saved on Enter, the button, or on opening a result.
- **The Search & Save button and its "Press Enter to run" hint are hidden** while `searchHistory.searchOnType` is on, since there is nothing left to press; a passive "Searching as you type — saved automatically" hint takes their place.

### Added

- **Live-refreshing results** — the in-view results now re-run automatically (debounced by `searchHistory.searchOnTypeDelay`) when you edit a file, mirroring VS Code's own Search view, so the match list stays current as you work. This refresh does not create new history entries.

## [1.1.0] - 2026-07-22

### Added

- **Native-style search bar** docked at the top of the Search History view — a webview that mirrors VS Code's Find-in-Files widget: query field with **Match Case / Whole Word / Regex** toggles that highlight when active (using the same theme colors as the native box), a collapsible **Replace** field, and clearly-labelled **files to include / exclude** fields, all visible at once. Expanding/collapsing the Replace and Search-details sections is animated with a smooth slide.
- **In-view search results** — pressing Enter runs the search and shows the matches **directly in the Search view**, grouped by file with the matching line and highlighted hits; click a line to jump to it in the editor. One window for search, results and history — no more bouncing to the native panel.
- **Search engine** with no bundled binaries: prefers the `ripgrep` that ships inside VS Code (streamed `--json` output) and falls back to a pure-`vscode`-API scan (`findFiles` + `readFile` + regex) when it can't be located, honouring include/exclude globs and (in the fallback) `files.exclude` / `search.exclude`.
- **Open in VS Code Search** button in the results header to hand the current query to the native panel — for exhaustive searches or replace-across-files.
- **Automatic capture** — rebind `Ctrl+Shift+F` to the bar (on by default) and every search you launch is saved to history without any extra step, with its query, flags, replace text, globs, timestamp and workspace.
- **Inline history suggestions** in the search bar: as you type, matching past searches (favorites first) appear and can be clicked to restore the full query, flags and globs.
- **Search as you type** (opt-in via `searchHistory.searchOnType`, with a configurable `searchHistory.searchOnTypeDelay`): shows a live preview of results while typing. To avoid flooding history with partial queries, a preview is only saved when you press Enter, use **Search & Save**, or open one of its results.
- **Replace text** is now stored per entry and restored on re-run (and distinguishes otherwise-identical searches for de-duplication).
- **Notes** — attach a free-text note to any entry via _Edit Note…_ in its right-click menu; notes are shown in the tooltip and included in filtering.
- `searchHistory.maxResults` setting (default `5000`) capping the in-view result count; searches stop early and are marked truncated when exceeded.

### Changed

- `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS) is **rebound by default** to focus the search bar, so your usual search shortcut captures automatically. Remove the binding for `searchHistory.newSearch` in Keyboard Shortcuts to restore the built-in behavior.
- The title-bar `+` and the _New Search_ welcome action now focus the search bar instead of opening a multi-step quick-input prompt.
- Clicking a history entry now **re-runs it in-view** (streaming results into the Search view) instead of opening the native panel.

### Removed

- The old multi-step **New Search & Save** quick-input flow (query prompt → include prompt → exclude prompt), superseded by the search bar.

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

[1.1.3]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.1.3
[1.1.2]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.1.2
[1.1.1]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.1.1
[1.1.0]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.1.0
[1.0.0]: https://github.com/ActiveClientMods/vscode-search-history/releases/tag/v1.0.0
