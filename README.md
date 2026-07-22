# Search History Explorer

> Track, filter, tag and reuse your VS Code searches — globally or per workspace.

Search History Explorer adds a dedicated **Search History** view to the Activity Bar with a built-in, native-style **search bar** on top. Bind it to `Ctrl+Shift+F` and every search you run flows through it — saved automatically with its query, flags, replace text and include/exclude patterns — so you can find that one clever regex from last week and re-run it in a single click.

## Features

- **Native-style search bar** — a search box that mirrors VS Code's own **Find in Files** widget (query + **Match Case / Whole Word / Regex** toggles that highlight when active, plus **Replace** and clearly-labelled **Include / Exclude** fields), docked at the top of the view. Running a search from here saves it and launches the native panel.
- **Results in the view** — press Enter and the matches appear **right below the search bar**, grouped by file with the matching line and highlighted hit; click any line to jump straight to it in the editor. No context switch — one window for searching, results and history. A one-click **Open in VS Code Search** hands the same search to the native panel when you want it (e.g. to replace across files).
- **Automatic capture** — rebind `Ctrl+Shift+F` to the bar (on by default) and every search you launch is appended to your history without any extra step. As you type, matching past searches (favorites first) appear as suggestions you can click to restore in full.
- **Rich history** — each entry records the query, timestamp, workspace name, replace text, include/exclude globs, an optional free-text **note**, and the **Regex / Match Case / Whole Word** flags.
- **Re-run instantly** — click an entry to re-run it and see its matches directly in the view (or send it on to the native panel).
- **Folders** — group topic-related searches into folders and **drag entries** into them (or use _Move to Folder…_). Folders can be **global** (shared across every workspace) or **workspace-specific**.
- **Filter & Sort menu** — the title-bar filter is a dropdown (like the Explorer's `…` menu): set a text/regex filter, filter by tag, toggle favorites-only, and clear — all clearly labelled, no guessing.
- **Tags & favorites** — tag searches freely and toggle the ⭐ directly on a row (outline ↔ filled). Favorites sort to the top and are protected from automatic pruning.
- **Global ↔ Workspace scope** — toggle between _all_ searches and only those made in the current workspace, straight from the view's title bar.
- **Automatic de-duplication** — re-running an identical search bumps its usage count instead of cluttering the list (configurable).

## Getting started

1. Open the **Search History** view from the Activity Bar (the magnifier-with-clock icon), or press `Ctrl+Shift+F` (rebound to focus the bar — see [Capturing searches](#capturing-searches--running-them-in-view)).
2. Type in the **search bar** at the top. Use the inline **Aa / ab / .\*** buttons to toggle Match Case, Whole Word and Regex — active toggles are highlighted just like the native Search box. Click the `›` chevron to reveal **Replace**, and fill the **files to include / exclude** fields as needed.
3. Press **Enter** (or **Search & Save**): the search runs and its **results appear in the view**, grouped by file — click a line to open it at the match. The search is also saved to your history. Use **Open in VS Code Search** to hand it to the native panel.
4. Later, click any entry to run it again, toggle its ⭐, or right-click for _Move to Folder…_, tags, **note**, copy and delete.

## Folders

Create a folder with **New Folder** (`⊞` in the title bar) — it's created in the current scope, so a folder made while viewing **Workspace** history stays with that workspace, while one made in **Global** view is shared everywhere. Group a search by **dragging it onto a folder**, or via **Move to Folder…** in its right-click menu (which can also create a new folder on the spot). Deleting a folder keeps its searches and moves them back to _Ungrouped_.

## Title-bar controls

| Control | Action |
| --- | --- |
| Add | Focus the search bar to start a new search |
| New Folder | Create a folder in the current scope |
| Globe / Folder | Switch between Global and Workspace scope |
| Filter & Sort | Dropdown: text/regex filter, filter by tag, favorites-only, clear filter |
| `…` overflow | Refresh, Clear history (current workspace or everything) |

## Settings

| Setting                           | Default | Description                                                                                       |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| `searchHistory.maxEntries`        | `5000`  | Maximum entries to retain. Favorites are never pruned; the oldest non-favorites go first.         |
| `searchHistory.deduplicate`       | `true`  | Fold identical re-runs into the existing entry.                                                   |
| `searchHistory.maxResults`        | `5000`  | Maximum matches to show in the in-view results list before the search stops early.                |
| `searchHistory.searchOnType`      | `false` | Search as you type, showing a live preview; only saved on Enter, the button, or opening a result. |
| `searchHistory.searchOnTypeDelay` | `300`   | Debounce delay (ms) before a search-as-you-type preview runs.                                     |

## Architecture

The extension deliberately uses **VS Code's native `Memento` storage** (`globalState`) rather than an embedded database. This decision was made after evaluating both options:

|                           | Native `Memento` (chosen)                                                                                | Embedded SQLite + Drizzle ORM                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Regex filtering**       | Compiled `RegExp` over an in-memory array — sub-millisecond for the realistic, **bounded** history size. | SQLite has **no built-in `REGEXP`**; you must register a JS callback and effectively scan rows in JS anyway, so the "query engine" advantage evaporates for this exact workload. |
| **Dependencies / bundle** | Zero runtime dependencies, no bundle-size cost.                                                          | Native module (`better-sqlite3`/libsql) **or** a WASM build, plus the ORM.                                                                                                       |
| **Packaging**             | Cross-platform out of the box.                                                                           | Native modules require platform-specific `.vsix` builds — a well-known source of pain.                                                                                           |
| **Sync**                  | Free profile sync via `setKeysForSync`.                                                                  | Manual.                                                                                                                                                                          |

Because search history is naturally bounded (and capped via `maxEntries`), and because regex matching has to happen in JavaScript either way, `Memento` is the faster _and_ simpler choice. The storage layer (`src/storage.ts`) is written against the small `Memento` interface, so it stays fully unit-testable and could be swapped for another backend without touching the UI.

## Capturing searches & running them in-view

VS Code does **not** expose an API to observe or intercept queries typed into the native Search panel, nor a supported API to run a text search and read the results back (`workspace.findTextInFiles` is still a proposed API). Rather than depend on undocumented internals, this extension **owns the entry point**: its search bar captures the query, flags, replace text and globs at the moment you launch a search.

To show results in the view, it **runs the search itself**: it prefers the `ripgrep` binary that ships inside VS Code, and falls back to a pure-`vscode`-API scan (`findFiles` + `readFile` + regex) if that binary cannot be located — so there are **no bundled native binaries** and the extension stays cross-platform. Results stream in file-by-file and respect your include/exclude globs (and, via the fallback, your `files.exclude` / `search.exclude` settings). For an exhaustive search over a very large repository, or to run a **replace across files**, use **Open in VS Code Search** to hand the same query to the native panel (via `workbench.action.findInFiles`).

By default the extension **rebinds `Ctrl+Shift+F`** to focus its search bar, so your usual search shortcut now captures automatically. If you prefer VS Code's built-in shortcut, remove the binding in **File → Preferences → Keyboard Shortcuts** (search for `searchHistory.newSearch`).

**Known limitations:** searches you start by clicking the Search icon in the Activity Bar directly (bypassing the bar) are _not_ captured. The in-view results are **read-only** (find and jump); replacing across files is delegated to the native panel. Result fidelity closely follows ripgrep, but some `.gitignore` edge cases and context lines differ from the native Search view.

## Project layout

| File                     | Responsibility                                                                 |
| ------------------------ | ------------------------------------------------------------------------------ |
| `src/types.ts`           | Shared domain types.                                                           |
| `src/storage.ts`         | `Memento`-backed CRUD store, dedupe & pruning.                                 |
| `src/filter.ts`          | Pure filtering & sorting (no `vscode` import — trivially testable).            |
| `src/workspace.ts`       | Stable workspace identity.                                                     |
| `src/searchEngine.ts`    | Text-search engine: bundled ripgrep with a pure-API JS fallback.               |
| `src/searchRunner.ts`    | Native Find-in-Files hand-off.                                                 |
| `src/searchBarView.ts`   | Native-style search-bar `WebviewViewProvider` (capture, results, suggestions). |
| `src/historyProvider.ts` | `TreeDataProvider`, view chrome and context keys.                              |
| `src/extension.ts`       | Activation and command wiring.                                                 |

## Development

This project uses **[Bun](https://bun.sh)** for all package management and scripts, **[oxlint](https://oxc.rs)** for linting, and TypeScript `7.0.2`.

```bash
bun install            # install dependencies
bun run check-types    # tsc --noEmit
bun run lint           # oxlint
bun run compile        # type-check, lint & bundle with esbuild
bun run test           # headless VS Code integration + unit tests
```

Tests run under `@vscode/test-electron`; on CI they are wrapped with `xvfb-run`.

## License

[MIT](LICENSE) © 2026 ActiveClientMods
