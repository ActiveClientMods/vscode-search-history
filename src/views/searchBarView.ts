import * as vscode from 'vscode';

import { type EngineFile, type EngineOutcome, runSearch } from '../search/searchEngine';
import {
	type MatchLocation,
	describeReplacement,
	planReplacements,
	replaceInFiles,
} from '../search/replaceEngine';
import type { HistoryStore } from '../core/storage';
import type { SearchHistoryEntry, SearchParams } from '../core/types';
import { buildPreviewWindow } from './resultPreview';
import { buildSearchBarHtml, makeNonce } from './searchBarHtml';

/** A history entry projected down to what the webview suggestion list needs. */
interface Suggestion extends SearchParams {
	id: string;
	note: string;
	favorite: boolean;
	workspaceName: string;
}

/** One occurrence, in raw document coordinates — enough to open or replace it. */
interface WireMatch {
	line: number;
	column: number;
	endColumn: number;
}

/** One matched line, already windowed down to what should be rendered. */
interface WireLine {
	line: number;
	/** The visible slice of the line (see {@link buildPreviewWindow}). */
	text: string;
	/** Highlight ranges within {@link text}, each paired with its match. */
	highlights: { start: number; end: number; match: WireMatch; replacement?: string }[];
	/** Every occurrence on this line, including any clipped out of {@link text}. */
	matches: WireMatch[];
	leadingElided: boolean;
	trailingElided: boolean;
}

/** One file's results, shaped for transfer to the webview. */
interface WireFile {
	uri: string;
	path: string;
	matchCount: number;
	lines: WireLine[];
}

/** Messages the webview sends to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'run'; params: SearchParams }
	| { type: 'preview'; params: SearchParams }
	| { type: 'runNoSave'; params: SearchParams }
	| { type: 'requestSuggestions'; query: string }
	| { type: 'openMatch'; uri: string; line: number; column: number; endColumn: number }
	| { type: 'openInNative' }
	| { type: 'replaceTextChanged'; replaceText: string }
	| { type: 'replaceAll' }
	| { type: 'replaceFile'; uri: string }
	| { type: 'replaceMatches'; uri: string; matches: MatchLocation[] }
	| { type: 'copyText'; text: string }
	| { type: 'copyPath'; uri: string }
	| { type: 'copyAll' };

/** Messages the extension host sends to the webview. */
type OutboundMessage =
	| { type: 'suggestions'; items: Suggestion[] }
	| { type: 'prefill'; params: SearchParams }
	| { type: 'focus' }
	| {
			type: 'config';
			searchOnType: boolean;
			delay: number;
			showSuggestions: boolean;
			rerunOnOptionToggle: boolean;
			saveOnOptionToggle: boolean;
	  }
	| { type: 'searchStarted' }
	| { type: 'results'; files: WireFile[] }
	| {
			type: 'searchDone';
			fileCount: number;
			matchCount: number;
			truncated: boolean;
			engine: string;
			error?: string;
	  }
	| { type: 'replaceDone'; message: string }
	| { type: 'clearInputs' }
	| { type: 'clearOptions' };

const MAX_SUGGESTIONS = 8;
const DEFAULT_MAX_RESULTS = 5000;
/** Above this many matches the inline replace preview is skipped (too costly to re-render). */
const MAX_PREVIEW_MATCHES = 2000;
/** Files changing on disk are noisier than typing, so they get a calmer debounce. */
const MIN_FILE_EVENT_DELAY = 500;

export interface SearchBarDeps {
	/** Persist a search that was just launched (returns the stored entry). */
	record: (params: SearchParams) => Promise<SearchHistoryEntry>;
	/** Hand the given search off to VS Code's native Search panel. */
	openInNative: (params: SearchParams) => Promise<void>;
}

/**
 * The native-style search bar + in-view results list at the top of the Search
 * History container. It mirrors VS Code's Find-in-Files widget, captures every
 * search launched through it, runs the search itself (see {@link runSearch}),
 * renders the results inline and can replace across them.
 */
export class SearchBarViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'searchHistory.searchBar';

	private view?: vscode.WebviewView;
	private searchTokens?: vscode.CancellationTokenSource;
	private lastParams?: SearchParams;
	/** Whether {@link lastParams} has already been persisted to history. */
	private lastParamsSaved = false;
	/** The result set currently on screen — kept for replace and re-rendering. */
	private lastFiles: EngineFile[] = [];
	/**
	 * Set whenever something could have changed the matches (an edit, a file
	 * event) since the displayed results were produced. While the view is on
	 * screen this triggers a debounced re-run; while it is hidden it is held
	 * until the view comes back, so results are never silently out of date.
	 */
	private resultsStale = false;
	/** Cached search-on-type configuration (kept in sync via {@link pushConfig}). */
	private searchOnType = false;
	private searchOnTypeDelay = 300;
	/** Debounce timer for re-running the active search after a change. */
	private rerunTimer?: ReturnType<typeof setTimeout>;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly store: HistoryStore,
		private readonly deps: SearchBarDeps,
	) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this.extensionUri],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((message: InboundMessage) => {
			switch (message.type) {
				case 'ready':
					void this.onWebviewReady();
					return;
				case 'run':
					void this.runAndRecord(message.params);
					return;
				case 'preview':
					// Search-as-you-type: unlike a manual run there is no button to
					// press, so a query the debounce settled on counts as intentional.
					void this.runAndRecord(message.params);
					return;
				case 'runNoSave':
					void this.runNoSave(message.params);
					return;
				case 'requestSuggestions':
					this.postSuggestions(message.query);
					return;
				case 'openMatch':
					void this.openMatch(message);
					return;
				case 'openInNative':
					if (this.lastParams) {
						void this.deps.openInNative(this.lastParams);
					}
					return;
				case 'replaceTextChanged':
					void this.onReplaceTextChanged(message.replaceText);
					return;
				case 'replaceAll':
					void this.replaceAll();
					return;
				case 'replaceFile':
					void this.replaceIn([message.uri]);
					return;
				case 'replaceMatches':
					void this.replaceIn([message.uri], new Map([[message.uri, message.matches]]));
					return;
				case 'copyText':
					void vscode.env.clipboard.writeText(message.text);
					return;
				case 'copyPath':
					void this.copyPath(message.uri);
					return;
				case 'copyAll':
					void this.copyAllResults();
					return;
			}
		});

		// The webview is torn down and rebuilt when the view is moved between
		// containers or the window reloads, which empties the results list while
		// `lastParams` survives. Treat that as stale so the results come back.
		webviewView.onDidDispose(() => {
			this.view = undefined;
			this.resultsStale = true;
		});
		webviewView.onDidChangeVisibility(() => {
			if (webviewView.visible) {
				void this.refreshIfStale();
			}
		});
	}

	/** Reveal the bar and move keyboard focus into the query field. */
	async focus(): Promise<void> {
		if (this.view) {
			this.view.show?.(false);
			await this.post({ type: 'focus' });
		} else {
			// The view has not been resolved yet; showing it triggers resolve, and
			// the webview focuses its own input on first render.
			await vscode.commands.executeCommand(`${SearchBarViewProvider.viewId}.focus`);
		}
	}

	/** Seed the bar's fields from an existing (already-saved) entry and run it in-view. */
	async prefillAndRun(params: SearchParams): Promise<void> {
		await this.focus();
		await this.post({ type: 'prefill', params });
		this.lastParamsSaved = true;
		await this.runInView(params);
	}

	/**
	 * Clear every search input (query, replace, include, exclude) and the in-view
	 * results. Also drops the active search so a subsequent Refresh has nothing
	 * stale to re-run. Backs the "Clear Search" title-bar action.
	 */
	clearInputs(): void {
		this.searchTokens?.cancel();
		this.searchTokens?.dispose();
		this.searchTokens = undefined;
		clearTimeout(this.rerunTimer);
		this.lastParams = undefined;
		this.lastParamsSaved = false;
		// Nothing is on screen any more, so there is nothing to replace across and
		// nothing a pending invalidation could usefully refresh.
		this.lastFiles = [];
		this.resultsStale = false;
		void this.post({ type: 'clearInputs' });
	}

	/**
	 * Reset the three match options (Match Case, Whole Word, Regex) without firing
	 * a search or touching history. Backs the "Clear Match Options" title-bar action.
	 */
	clearOptions(): void {
		void this.post({ type: 'clearOptions' });
	}

	/**
	 * Re-run the currently active search in-view (no history write). Backs the
	 * search-bar "Refresh" action, which refreshes the visible results in addition
	 * to the history tree, and every automatic refresh below. A no-op when nothing
	 * has been searched yet.
	 */
	async rerunActiveSearch(): Promise<void> {
		clearTimeout(this.rerunTimer);
		if (this.lastParams) {
			await this.runInView(this.lastParams);
		}
	}

	/** Push the current search-on-type configuration to the webview. */
	async pushConfig(): Promise<void> {
		const config = vscode.workspace.getConfiguration('searchHistory');
		this.searchOnType = config.get<boolean>('searchOnType', false);
		this.searchOnTypeDelay = config.get<number>('searchOnTypeDelay', 300);
		await this.post({
			type: 'config',
			searchOnType: this.searchOnType,
			delay: this.searchOnTypeDelay,
			showSuggestions: config.get<boolean>('showSuggestions', false),
			rerunOnOptionToggle: config.get<boolean>('rerunOnOptionToggle', true),
			saveOnOptionToggle: config.get<boolean>('saveOnOptionToggle', true),
		});
	}

	/**
	 * Re-run the active search when a file is edited, mirroring VS Code's own
	 * Search view. Debounced by {@link searchOnTypeDelay}.
	 */
	onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (event.contentChanges.length === 0) {
			return;
		}
		this.invalidate(this.searchOnTypeDelay);
	}

	/**
	 * Files changed on disk — a save, a branch switch, a generated file. The
	 * editor-change event does not cover these, and without them results silently
	 * describe a workspace that no longer exists.
	 */
	onWorkspaceFilesChanged(): void {
		this.invalidate(Math.max(this.searchOnTypeDelay, MIN_FILE_EVENT_DELAY));
	}

	/**
	 * Mark the displayed results as possibly out of date. Refreshing is only
	 * worth doing while the view is on screen; otherwise the flag is held and
	 * {@link refreshIfStale} picks it up when the view is revealed again — which
	 * is what makes "switch to Explorer, edit, switch back" show current results.
	 */
	private invalidate(delay: number): void {
		if (!this.lastParams) {
			return;
		}
		this.resultsStale = true;
		if (!this.isVisible()) {
			return;
		}
		clearTimeout(this.rerunTimer);
		this.rerunTimer = setTimeout(() => void this.refreshIfStale(), delay);
	}

	private isVisible(): boolean {
		return this.view?.visible === true;
	}

	private async refreshIfStale(): Promise<void> {
		if (this.resultsStale) {
			await this.rerunActiveSearch();
		}
	}

	private async onWebviewReady(): Promise<void> {
		await this.pushConfig();
		// A rebuilt webview starts with an empty results list; restore it.
		await this.refreshIfStale();
	}

	/**
	 * Run the search in-view without recording it. Used when a match-option toggle
	 * re-runs the search but the user has disabled saving toggled runs
	 * (`saveOnOptionToggle`). Marking it unsaved means opening one of its results —
	 * or pressing Enter / the button — still captures it to history.
	 */
	private async runNoSave(params: SearchParams): Promise<void> {
		if (params.query.trim() === '') {
			return;
		}
		this.lastParamsSaved = false;
		await this.runInView(params);
	}

	/**
	 * Run the search in-view and persist it — but only when it actually ran to
	 * completion (not superseded by a newer keystroke) and the query is not an
	 * invalid regular expression. Invalid-regex queries are shown as an error but
	 * never pollute the history.
	 */
	private async runAndRecord(params: SearchParams): Promise<void> {
		if (params.query.trim() === '') {
			return;
		}
		this.lastParamsSaved = false;
		const outcome = await this.runInView(params);
		if (!outcome || outcome.regexInvalid) {
			return;
		}
		await this.deps.record(params);
		this.lastParamsSaved = true;
	}

	/**
	 * Run the search and stream results into the webview, cancelling any prior run.
	 * Returns the outcome, or `undefined` if this run was superseded (cancelled)
	 * before it finished.
	 */
	private async runInView(params: SearchParams): Promise<EngineOutcome | undefined> {
		this.searchTokens?.cancel();
		this.searchTokens?.dispose();
		const tokens = new vscode.CancellationTokenSource();
		this.searchTokens = tokens;
		this.lastParams = params;
		this.lastFiles = [];
		// Cleared up front: anything that changes *during* the run must still count
		// as stale, or a concurrent edit would be swallowed by this refresh.
		this.resultsStale = false;
		clearTimeout(this.rerunTimer);

		await this.post({ type: 'searchStarted' });
		const maxMatches = vscode.workspace
			.getConfiguration('searchHistory')
			.get<number>('maxResults', DEFAULT_MAX_RESULTS);

		const outcome = await runSearch(params, {
			maxMatches,
			token: tokens.token,
			onFile: (file) => {
				if (!tokens.token.isCancellationRequested) {
					this.lastFiles.push(file);
					void this.post({ type: 'results', files: [this.toWireFile(file)] });
				}
			},
		});

		if (tokens.token.isCancellationRequested) {
			return undefined;
		}
		await this.post({ type: 'searchDone', ...outcome });
		return outcome;
	}

	// --- Replace -------------------------------------------------------------

	/**
	 * The replacement text changed while results are on screen. It is not a new
	 * search — it only changes what the inline preview shows — so re-render the
	 * retained results rather than re-running anything.
	 */
	private async onReplaceTextChanged(replaceText: string): Promise<void> {
		if (!this.lastParams || this.lastParams.replaceText === replaceText) {
			return;
		}
		this.lastParams = { ...this.lastParams, replaceText };
		// Changing the replacement does not change *which* entry this is, so the
		// saved-state flag is deliberately left alone.
		if (this.lastFiles.length === 0 || this.totalMatches() > MAX_PREVIEW_MATCHES) {
			return; // nothing on screen, or too much of it to preview
		}
		await this.post({ type: 'searchStarted' });
		await this.post({ type: 'results', files: this.lastFiles.map((f) => this.toWireFile(f)) });
		await this.post({
			type: 'searchDone',
			fileCount: this.lastFiles.length,
			matchCount: this.totalMatches(),
			truncated: false,
			engine: 'js',
		});
	}

	/** Replace every match of the current search, after confirming. */
	private async replaceAll(): Promise<void> {
		const params = this.lastParams;
		if (!params || this.lastFiles.length === 0) {
			return;
		}
		const summary = describeReplacement(this.lastFiles.length, this.totalMatches());
		const target = params.replaceText === '' ? 'nothing (deleting them)' : `"${params.replaceText}"`;
		const confirm = await vscode.window.showWarningMessage(
			`Replace ${summary} of "${params.query}" with ${target}?`,
			{ modal: true, detail: 'Files are left unsaved so a single Undo reverts everything.' },
			'Replace All',
		);
		if (confirm !== 'Replace All') {
			return;
		}
		await this.replaceIn(this.lastFiles.map((f) => f.uri.toString()));
	}

	/**
	 * Apply the replacement to the given files, optionally narrowed to specific
	 * occurrences, then re-run the search so the list reflects the new text.
	 */
	private async replaceIn(
		uris: readonly string[],
		locations?: ReadonlyMap<string, MatchLocation[]>,
	): Promise<void> {
		const params = this.lastParams;
		if (!params) {
			return;
		}
		const result = await replaceInFiles(uris.map((u) => vscode.Uri.parse(u)), params, locations);
		if (result.error) {
			void vscode.window.showErrorMessage(`Replace failed: ${result.error}`);
			await this.post({ type: 'replaceDone', message: result.error });
			return;
		}
		const message = result.matches === 0
			? 'Nothing to replace — the results were out of date.'
			: `Replaced ${describeReplacement(result.files, result.matches)}.`;
		await this.post({ type: 'replaceDone', message });
		// The replaced files are now dirty; the search re-reads them from memory.
		await this.runInView(params);
	}

	private totalMatches(): number {
		return this.lastFiles.reduce((sum, file) => sum + file.matches.length, 0);
	}

	// --- Clipboard -----------------------------------------------------------

	/** Copy a file's absolute path (VS Code's "Copy Path"). */
	private async copyPath(uri: string): Promise<void> {
		await vscode.env.clipboard.writeText(vscode.Uri.parse(uri).fsPath);
	}

	/**
	 * Copy every result on screen as plain text, grouped by file with each matching
	 * line prefixed by its line number — the shape VS Code's "Copy All" produces.
	 */
	private async copyAllResults(): Promise<void> {
		const blocks: string[] = [];
		for (const file of this.lastFiles) {
			const rows: string[] = [file.relativePath];
			const seen = new Set<number>();
			for (const match of file.matches) {
				if (seen.has(match.line)) {
					continue; // one row per line even when it has several hits
				}
				seen.add(match.line);
				rows.push(`  ${match.line}: ${match.preview.trim()}`);
			}
			blocks.push(rows.join('\n'));
		}
		if (blocks.length > 0) {
			await vscode.env.clipboard.writeText(`${blocks.join('\n\n')}\n`);
		}
	}

	// --- Rendering -----------------------------------------------------------

	/**
	 * Project one file's matches into the shape the webview renders: grouped by
	 * line and windowed so the match itself is always inside the visible slice.
	 */
	private toWireFile(file: EngineFile): WireFile {
		const showPreview =
			this.lastParams !== undefined &&
			this.lastParams.replaceText !== '' &&
			this.totalMatches() <= MAX_PREVIEW_MATCHES;

		// Several hits on one line share a row. The engine may have sliced a very
		// long line differently per hit, so the first one's slice sets the frame.
		const byLine = new Map<number, { preview: string; previewStart: number; matches: WireMatch[] }>();
		for (const match of file.matches) {
			let group = byLine.get(match.line);
			if (!group) {
				group = { preview: match.preview, previewStart: match.previewStart, matches: [] };
				byLine.set(match.line, group);
			}
			group.matches.push({ line: match.line, column: match.column, endColumn: match.endColumn });
		}

		const lines: WireLine[] = [];
		for (const [line, group] of byLine) {
			const window = buildPreviewWindow(
				group.preview,
				group.matches.map((m) => [m.column, m.endColumn] as const),
				{ offset: group.previewStart },
			);
			lines.push({
				line,
				text: window.text,
				leadingElided: window.leadingElided,
				trailingElided: window.trailingElided,
				matches: group.matches,
				highlights: window.highlights.map((h) => ({
					start: h.start,
					end: h.end,
					match: group.matches[h.index],
					replacement: showPreview
						? this.previewReplacement(group.preview, group.previewStart, group.matches[h.index])
						: undefined,
				})),
			});
		}
		return { uri: file.uri.toString(), path: file.relativePath, matchCount: file.matches.length, lines };
	}

	/**
	 * What one occurrence would become — used only for the strikethrough preview,
	 * so a failure to reproduce the match (ripgrep's regex dialect is not quite
	 * JavaScript's) simply means no preview for that hit.
	 */
	private previewReplacement(line: string, offset: number, match: WireMatch): string | undefined {
		const params = this.lastParams;
		if (!params) {
			return undefined;
		}
		if (!params.isRegex) {
			return params.replaceText;
		}
		const { plan } = planReplacements([line], params);
		return plan.find((p) => p.column === match.column - offset)?.replacement;
	}

	private async openMatch(msg: { uri: string; line: number; column: number; endColumn: number }): Promise<void> {
		// Opening a result means the (possibly search-as-you-type) query mattered:
		// capture it now if it hasn't been saved yet.
		if (this.lastParams && !this.lastParamsSaved) {
			await this.deps.record(this.lastParams);
			this.lastParamsSaved = true;
		}
		try {
			const uri = vscode.Uri.parse(msg.uri);
			const doc = await vscode.workspace.openTextDocument(uri);
			const editor = await vscode.window.showTextDocument(doc, { preview: true });
			const start = new vscode.Position(Math.max(0, msg.line - 1), msg.column);
			const end = new vscode.Position(Math.max(0, msg.line - 1), msg.endColumn);
			editor.selection = new vscode.Selection(start, end);
			editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		} catch (err) {
			void vscode.window.showErrorMessage(`Could not open match: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private postSuggestions(rawQuery: string): void {
		const needle = rawQuery.trim().toLowerCase();
		const entries = this.store.getAll();
		const matched = needle === ''
			? entries
			: entries.filter((e) => matchesSuggestion(e, needle));
		const items = matched
			.toSorted(byFavoriteThenRecent)
			.slice(0, MAX_SUGGESTIONS)
			.map(toSuggestion);
		void this.post({ type: 'suggestions', items });
	}

	private post(message: OutboundMessage): Thenable<boolean> {
		// VS Code's Webview.postMessage takes no targetOrigin (not window.postMessage).
		// oxlint-disable-next-line unicorn/require-post-message-target-origin
		return this.view?.webview.postMessage(message) ?? Promise.resolve(false);
	}

	private getHtml(webview: vscode.Webview): string {
		const asset = (...parts: string[]) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts)).toString();
		return buildSearchBarHtml({
			styleUri: asset('media', 'searchBar.css'),
			scriptUri: asset('media', 'searchBar.js'),
			cspSource: webview.cspSource,
			nonce: makeNonce(),
		});
	}
}

function matchesSuggestion(entry: SearchHistoryEntry, needle: string): boolean {
	return (
		entry.query.toLowerCase().includes(needle) ||
		entry.note.toLowerCase().includes(needle) ||
		entry.tags.some((t) => t.toLowerCase().includes(needle))
	);
}

function byFavoriteThenRecent(a: SearchHistoryEntry, b: SearchHistoryEntry): number {
	if (a.favorite !== b.favorite) {
		return a.favorite ? -1 : 1;
	}
	return b.lastUsedAt - a.lastUsedAt;
}

function toSuggestion(entry: SearchHistoryEntry): Suggestion {
	return {
		id: entry.id,
		query: entry.query,
		isRegex: entry.isRegex,
		isCaseSensitive: entry.isCaseSensitive,
		matchWholeWord: entry.matchWholeWord,
		replaceText: entry.replaceText,
		filesToInclude: entry.filesToInclude,
		filesToExclude: entry.filesToExclude,
		note: entry.note,
		favorite: entry.favorite,
		workspaceName: entry.workspaceName,
	};
}
