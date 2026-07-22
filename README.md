# Search History Explorer

> Track, filter, tag and reuse your VS Code searches — globally or per workspace.

Search History Explorer adds a dedicated **Search History** view to the Activity Bar. Every search you launch through the view is saved with its query, flags and include/exclude patterns, so you can find that one clever regex from last week and re-run it in a single click.

## Features

- **Rich history** — each entry records the query, timestamp, workspace name, include/exclude globs and the **Regex / Match Case / Whole Word** flags.
- **Re-run instantly** — click an entry to open VS Code's native **Find in Files** panel pre-filled with the exact query, flags and paths.
- **Folders** — group topic-related searches into folders and **drag entries** into them (or use _Move to Folder…_). Folders can be **global** (shared across every workspace) or **workspace-specific**.
- **Filter & Sort menu** — the title-bar filter is a dropdown (like the Explorer's `…` menu): set a text/regex filter, filter by tag, toggle favorites-only, and clear — all clearly labelled, no guessing.
- **Tags & favorites** — tag searches freely and toggle the ⭐ directly on a row (outline ↔ filled). Favorites sort to the top and are protected from automatic pruning.
- **Global ↔ Workspace scope** — toggle between _all_ searches and only those made in the current workspace, straight from the view's title bar.
- **Automatic de-duplication** — re-running an identical search bumps its usage count instead of cluttering the list (configurable).

## Getting started

1. Open the **Search History** view from the Activity Bar (the magnifier-with-clock icon).
2. Click **New Search & Save** (`+` in the title bar). Enter a query — use the inline **Aa / ab / .\*** buttons to toggle Match Case, Whole Word and Regex; active toggles are highlighted and their on/off state is echoed in the prompt. Then optionally add include/exclude globs.
3. The search runs immediately in the editor **and** is saved to your history.
4. Later, click any entry to run it again, toggle its ⭐, or right-click for _Move to Folder…_, tags, copy and delete.

## Folders

Create a folder with **New Folder** (`⊞` in the title bar) — it's created in the current scope, so a folder made while viewing **Workspace** history stays with that workspace, while one made in **Global** view is shared everywhere. Group a search by **dragging it onto a folder**, or via **Move to Folder…** in its right-click menu (which can also create a new folder on the spot). Deleting a folder keeps its searches and moves them back to _Ungrouped_.

## Title-bar controls

| Control | Action |
| --- | --- |
| Add | New search & save |
| New Folder | Create a folder in the current scope |
| Globe / Folder | Switch between Global and Workspace scope |
| Filter & Sort | Dropdown: text/regex filter, filter by tag, favorites-only, clear filter |
| `…` overflow | Refresh, Clear history (current workspace or everything) |

## Settings

| Setting                     | Default | Description                                                                               |
| --------------------------- | ------- | ----------------------------------------------------------------------------------------- |
| `searchHistory.maxEntries`  | `5000`  | Maximum entries to retain. Favorites are never pruned; the oldest non-favorites go first. |
| `searchHistory.deduplicate` | `true`  | Fold identical re-runs into the existing entry.                                           |

## Architecture

The extension deliberately uses **VS Code's native `Memento` storage** (`globalState`) rather than an embedded database. This decision was made after evaluating both options:

|                           | Native `Memento` (chosen)                                                                                | Embedded SQLite + Drizzle ORM                                                                                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Regex filtering**       | Compiled `RegExp` over an in-memory array — sub-millisecond for the realistic, **bounded** history size. | SQLite has **no built-in `REGEXP`**; you must register a JS callback and effectively scan rows in JS anyway, so the "query engine" advantage evaporates for this exact workload. |
| **Dependencies / bundle** | Zero runtime dependencies, no bundle-size cost.                                                          | Native module (`better-sqlite3`/libsql) **or** a WASM build, plus the ORM.                                                                                                       |
| **Packaging**             | Cross-platform out of the box.                                                                           | Native modules require platform-specific `.vsix` builds — a well-known source of pain.                                                                                           |
| **Sync**                  | Free profile sync via `setKeysForSync`.                                                                  | Manual.                                                                                                                                                                          |

Because search history is naturally bounded (and capped via `maxEntries`), and because regex matching has to happen in JavaScript either way, `Memento` is the faster _and_ simpler choice. The storage layer (`src/storage.ts`) is written against the small `Memento` interface, so it stays fully unit-testable and could be swapped for another backend without touching the UI.

### A note on "intercepting" searches

VS Code does **not** expose an API to observe or intercept queries typed into the native Search panel. This extension therefore captures searches at the point you launch them **through the view** (or the _New Search & Save_ command), which is the only reliable, forward-compatible approach. Re-running is done via the supported `workbench.action.findInFiles` command.

## Project layout

| File                     | Responsibility                                                      |
| ------------------------ | ------------------------------------------------------------------- |
| `src/types.ts`           | Shared domain types.                                                |
| `src/storage.ts`         | `Memento`-backed CRUD store, dedupe & pruning.                      |
| `src/filter.ts`          | Pure filtering & sorting (no `vscode` import — trivially testable). |
| `src/workspace.ts`       | Stable workspace identity.                                          |
| `src/searchRunner.ts`    | Native-search trigger and the _New Search_ input flow.              |
| `src/historyProvider.ts` | `TreeDataProvider`, view chrome and context keys.                   |
| `src/extension.ts`       | Activation and command wiring.                                      |

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
