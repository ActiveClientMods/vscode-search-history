# Search History Explorer

> Track, filter, tag and reuse your VS Code searches — globally or per workspace.

Search History Explorer adds a dedicated **Search History** view to the Activity Bar with a built-in, native-style **search bar** on top. Bind it to `Ctrl+Shift+F` and every search you run flows through it — saved automatically with its query, flags, replace text and include/exclude patterns — so you can find that one clever regex from last week and re-run it in a single click.

## Features

- **Native-style search bar** — a search box that mirrors VS Code's own **Find in Files** widget (query + **Match Case / Whole Word / Regex** toggles that highlight when active, plus **Replace** and clearly-labelled **Include / Exclude** fields), docked at the top of the view. Running a search from here saves it and launches the native panel.
- **Results in the view** — press Enter and the matches appear **right below the search bar**, grouped by file with the matching line and highlighted hit; click any line to jump straight to it in the editor. No context switch — one window for searching, results and history. Files are listed in **path order (A→Z)**, so the same search always produces the same list and a re-run only moves the rows that actually changed. Long lines are **trimmed around the match**, so a hit at the far end of a line is still the thing you see. **Right-click a result** for a native-style menu — Replace All, Dismiss, include/exclude by file type, and Copy / Copy Path / Copy All. A one-click **Open in VS Code Search** hands the same search to the native panel when you want it.
- **Replace in the view** — type a replacement and use the **Replace All** icon beside the field (or `Enter` in it, or `Ctrl+Alt+Enter`), or replace just one file or one row from the icons that appear on hover. Matches are previewed struck-through with their replacement as you type. Replace All confirms first, and files are left unsaved so a single **Undo** reverts the lot. Regex replacements expand `$1`, `$&`, `$<name>` and `\n`. Replacing honours every match option — Match Case, Whole Word and Regex — and touches only what the list is showing, so a **dismissed** row stays untouched.
- **Results that stay current** — the list re-runs itself (debounced) when you edit a file, when files change on disk, and when you come back to the view after working elsewhere. **Unsaved editors are searched as they are on screen**, not as they were last saved.
- **Search as you type** — turn on `searchHistory.searchOnType` and results update as you type; the **Search & Save** button hides and each query you pause on is **saved to history automatically**.
- **Automatic capture** — rebind `Ctrl+Shift+F` to the bar (on by default) and every search you launch is appended to your history without any extra step. Optionally (via `searchHistory.showSuggestions`) matching past searches appear as a dropdown you can click to restore in full.
- **Rich history** — each entry records the query, timestamp, workspace name, replace text, include/exclude globs, an optional free-text **note**, and the **Regex / Match Case / Whole Word** flags.
- **Re-run instantly** — click an entry to re-run it and see its matches directly in the view (or send it on to the native panel).
- **Folders** — group topic-related searches into folders and **drag entries** into them (or use _Move to Folder…_). Folders can be **global** (shared across every workspace) or **workspace-specific**.
- **Filter & Sort menu** — the title-bar filter is a dropdown (like the Explorer's `…` menu): set a text/regex filter, filter by tag, toggle favorites-only, and clear — all clearly labelled, no guessing.
- **Tags & favorites** — favorited rows show a filled gold ⭐ on the left as an at-a-glance indicator (non-favorites show no leading icon); to toggle, click the inline star that appears on hover or use the right-click menu. Favorites sort to the top and are protected from automatic pruning.
- **Global ↔ Workspace scope** — toggle between _all_ searches and only those made in the current workspace, straight from the view's title bar.
- **Automatic de-duplication** — re-running an identical search bumps its usage count instead of cluttering the list (configurable).

## Getting started

1. Open the **Search History** view from the Activity Bar (the magnifier-with-clock icon), or press `Ctrl+Shift+F` (rebound to focus the bar — see [Capturing searches](#capturing-searches--running-them-in-view)).
2. Type in the **search bar** at the top. Use the inline **Aa / ab / .\*** buttons to toggle Match Case, Whole Word and Regex — active toggles are highlighted just like the native Search box. Click the `›` chevron to reveal **Replace**, and fill the **files to include / exclude** fields as needed.
3. Press **Enter** (or **Search & Save**): the search runs and its **results appear in the view**, grouped by file — click a line to open it at the match. The search is also saved to your history. Use **Open in VS Code Search** to hand it to the native panel.
4. To replace, open the **Replace** field and type the replacement — matches are previewed struck-through with their result. Then press **Enter** (or the **Replace All** icon beside the field, or `Ctrl+Alt+Enter`) to replace everywhere, or hover a file or a result row and use its replace icon for something narrower. Nothing is saved to disk, so `Ctrl+Z` undoes the whole replacement.
5. Later, click any entry to run it again, toggle its ⭐, or right-click for _Move to Folder…_, tags, **note**, copy and delete.

## Folders

Create a folder with **New Folder** (`⊞` in the title bar) — it's created in the current scope, so a folder made while viewing **Workspace** history stays with that workspace, while one made in **Global** view is shared everywhere. Group a search by **dragging it onto a folder**, or via **Move to Folder…** in its right-click menu (which can also create a new folder on the spot). Deleting a folder keeps its searches and moves them back to _Ungrouped_.

## Title-bar controls

**Search view** (the search bar):

| Control             | Action                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------- |
| Refresh             | Re-run the active search (refreshing the in-view results, no new history entry) and reload the history list |
| Clear Search        | Empty the query, replace and include/exclude fields (and clear the in-view results)                         |
| Clear Match Options | Uncheck Match Case, Whole Word and Regex (without running a search)                                         |

**History view:**

| Control        | Action                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------- |
| Add            | Focus the search bar to start a new search                                               |
| New Folder     | Create a folder in the current scope                                                     |
| Globe / Folder | Switch between Global and Workspace scope                                                |
| Filter & Sort  | Dropdown: text/regex filter, filter by tag, favorites-only, clear filter                 |
| `…` overflow   | Refresh (reloads the history list only), Clear history (current workspace or everything) |

## Settings

| Setting                             | Default | Description                                                                                              |
| ----------------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `searchHistory.maxEntries`          | `5000`  | Maximum entries to retain. Favorites are never pruned; the oldest non-favorites go first.                |
| `searchHistory.deduplicate`         | `true`  | Fold identical re-runs into the existing entry.                                                          |
| `searchHistory.maxResults`          | `5000`  | Maximum matches to show in the in-view results list before the search stops early.                       |
| `searchHistory.searchOnType`        | `false` | Search as you type; each query you pause on is saved automatically and the Search & Save button hides.   |
| `searchHistory.searchOnTypeDelay`   | `300`   | Debounce delay (ms) before a search runs (as-you-type and after a file edit).                            |
| `searchHistory.showSuggestions`     | `false` | Show a dropdown of matching past searches while typing in the search bar.                                |
| `searchHistory.rerunOnOptionToggle` | `true`  | Re-run the current search when you toggle Match Case, Whole Word or Regex. Off = only update the flag.   |
| `searchHistory.saveOnOptionToggle`  | `true`  | When a match-option toggle re-runs the search, also save that run to history (only if re-running is on). |

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

To show results in the view, it **runs the search itself**: it prefers the `ripgrep` binary that ships inside VS Code, and falls back to a pure-`vscode`-API scan (`findFiles` + `readFile` + regex) if that binary cannot be located — so there are **no bundled native binaries** and the extension stays cross-platform. Results stream in file-by-file and respect your include/exclude globs (and, via the fallback, your `files.exclude` / `search.exclude` settings). For an exhaustive search over a very large repository, use **Open in VS Code Search** to hand the same query to the native panel (via `workbench.action.findInFiles`).

Result scope follows VS Code's Search view rather than ripgrep's defaults: hidden files are searched (with `files.exclude` / `search.exclude` pruning `.git`, `node_modules` and the like), while the user's **global** gitignore and **parent-directory** ignore files are honoured only when the corresponding `search.useGlobalIgnoreFiles` / `search.useParentIgnoreFiles` settings are on. The **files to include** field also accepts real paths — absolute, or `./`-relative to the workspace — and searches inside them, not just glob name filters.

Both backends read from disk, which would mean an editor with unsaved changes gets searched in its last-saved state — precisely when you are iterating fastest. So files with unsaved changes are withheld from the backend's output and scanned from the in-memory document instead, honouring the same include/exclude scoping.

Results are listed in path order rather than in the order the backend produced them. Ripgrep searches in parallel and both backends report each file the moment they finish it, so the same search returns the same files in a different order nearly every time; sorting makes the list a stable function of the matches, so an automatic re-run (an edit, a save, a replace) leaves every unchanged row exactly where it was. Files stream in as they are found and are spliced into their sorted position, so nothing has to be buffered until the end.

Replacing goes through VS Code's `WorkspaceEdit`, the same mechanism a refactoring uses: files are left **unsaved** so one Undo reverts everything. Each target file is re-scanned at the moment you replace rather than trusting the displayed match positions, so a result row that has since gone stale can never rewrite the wrong text. That re-scan uses JavaScript's `RegExp`, so it has to agree with ripgrep about what a match is: **Whole Word** is therefore compiled the way ripgrep's `--word-regexp` behaves (Unicode-aware boundaries that do not require the query itself to begin or end with a word character), not as a naive `\b…\b` wrap.

By default the extension **rebinds `Ctrl+Shift+F`** to focus its search bar, so your usual search shortcut now captures automatically. If you prefer VS Code's built-in shortcut, remove the binding in **File → Preferences → Keyboard Shortcuts** (search for `searchHistory.newSearch`).

**Known limitations:** searches you start by clicking the Search icon in the Activity Bar directly (bypassing the bar) are _not_ captured. Result fidelity closely follows ripgrep, but some `.gitignore` edge cases and context lines differ from the native Search view. Because replacements are applied with JavaScript's regular expressions while ripgrep matches with Rust's, a pattern using syntax only one of them supports can match in the results but not be replaced — such occurrences are skipped and reported rather than replaced incorrectly.

## Project layout

The source is grouped by concern: a `vscode`-light domain layer (`core`), the
search engines (`search`), the UI (`views`), and command wiring (`commands`).

| Path                                        | Responsibility                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/extension.ts`                          | Activation: constructs the store, tree view and search-bar, then wires commands and events.                                                                                                                                                                                                                                                                     |
| `src/core/`                                 | Storage-agnostic domain layer. `types` (shared types), `storage` (`Memento` CRUD, dedupe & pruning), `filter` (pure filter/sort, no `vscode`), `workspace` (stable identity).                                                                                                                                                                                   |
| `src/search/`                               | Text search and replace. `engineCore` (shared types/helpers), `ripgrepEngine`, `jsEngine`, `searchEngine` (backend dispatcher, unsaved-editor overlay, public API), `replaceEngine` (planning/applying replacements), `globMatch` (include/exclude scoping), `resultOrder` (path ordering of the results list), `searchRunner` (native Find-in-Files hand-off). |
| `src/views/`                                | The UI. `searchBarView` (search-bar webview host), `searchBarHtml` (its markup), `resultPreview` (windowing a matched line), `historyProvider` (`TreeDataProvider` + drag/drop + view chrome), `treeItems` (TreeItem classes), `treeFormatting` (label/tooltip rendering).                                                                                      |
| `src/commands/`                             | Command handlers grouped by concern — `entryCommands`, `folderCommands`, `filterCommands` — plus shared `helpers` and the `registerCommands` entry point.                                                                                                                                                                                                       |
| `media/searchBar.css`, `media/searchBar.js` | The search-bar webview's stylesheet and client script, loaded from disk via `asWebviewUri` (kept out of the `.ts` so they get proper tooling).                                                                                                                                                                                                                  |

## Development

This project uses **[Bun](https://bun.sh)** for all package management and scripts, **[oxlint](https://oxc.rs)** for linting, and TypeScript `7.0.2`.

```bash
bun install            # install dependencies
bun run check-types    # tsc --noEmit
bun run lint           # oxlint
bun run compile        # type-check, lint & bundle with esbuild
bun run test           # headless VS Code integration + unit tests
```

Tests run under `@vscode/test-electron`; on CI they are wrapped with `xvfb-run`. They open `src/test/workspace` as the workspace folder so the search and replace paths can be exercised against real files, driving the search bar end to end through a fake webview (`src/test/fakeWebviewView.ts`).

## License

[MIT](LICENSE) © 2026 ActiveClientMods
