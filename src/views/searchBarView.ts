import * as vscode from 'vscode';

import { type EngineFile, type EngineOutcome, runSearch } from '../search/searchEngine';
import type { HistoryStore } from '../core/storage';
import type { SearchHistoryEntry, SearchParams } from '../core/types';

/** A history entry projected down to what the webview suggestion list needs. */
interface Suggestion extends SearchParams {
	id: string;
	note: string;
	favorite: boolean;
	workspaceName: string;
}

/** One file's results, shaped for transfer to the webview. */
interface WireFile {
	uri: string;
	path: string;
	matches: { line: number; column: number; endColumn: number; preview: string }[];
}

/** Messages the webview sends to the extension host. */
type InboundMessage =
	| { type: 'ready' }
	| { type: 'run'; params: SearchParams }
	| { type: 'preview'; params: SearchParams }
	| { type: 'requestSuggestions'; query: string }
	| { type: 'openMatch'; uri: string; line: number; column: number; endColumn: number }
	| { type: 'openInNative' };

/** Messages the extension host sends to the webview. */
type OutboundMessage =
	| { type: 'suggestions'; items: Suggestion[] }
	| { type: 'prefill'; params: SearchParams }
	| { type: 'focus' }
	| { type: 'config'; searchOnType: boolean; delay: number; showSuggestions: boolean }
	| { type: 'searchStarted' }
	| { type: 'results'; files: WireFile[] }
	| { type: 'searchDone'; fileCount: number; matchCount: number; truncated: boolean; engine: string; error?: string };

const MAX_SUGGESTIONS = 8;
const DEFAULT_MAX_RESULTS = 5000;

export interface SearchBarDeps {
	/** Persist a search that was just launched (returns the stored entry). */
	record: (params: SearchParams) => Promise<SearchHistoryEntry>;
	/** Hand the given search off to VS Code's native Search panel. */
	openInNative: (params: SearchParams) => Promise<void>;
}

/**
 * The native-style search bar + in-view results list at the top of the Search
 * History container. It mirrors VS Code's Find-in-Files widget, captures every
 * search launched through it, runs the search itself (see {@link runSearch}) and
 * renders the results inline so you never leave the view.
 */
export class SearchBarViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewId = 'searchHistory.searchBar';

	private view?: vscode.WebviewView;
	private searchTokens?: vscode.CancellationTokenSource;
	private lastParams?: SearchParams;
	/** Whether {@link lastParams} has already been persisted to history. */
	private lastParamsSaved = false;
	/** Cached search-on-type configuration (kept in sync via {@link pushConfig}). */
	private searchOnType = false;
	private searchOnTypeDelay = 300;
	/** Debounce timer for re-running the active search when files change. */
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
					void this.pushConfig();
					return;
				case 'run':
					void this.handleRun(message.params);
					return;
				case 'preview':
					void this.handlePreview(message.params);
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
		});
	}

	/**
	 * Re-run the active search when a file is edited, mirroring VS Code's own
	 * Search view (which live-refreshes its results as files change). Debounced by
	 * {@link searchOnTypeDelay} and a no-op unless a search is currently shown.
	 */
	onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (!this.lastParams || event.contentChanges.length === 0) {
			return;
		}
		// Only bother while the view is actually on screen.
		if (this.view && this.view.visible === false) {
			return;
		}
		clearTimeout(this.rerunTimer);
		this.rerunTimer = setTimeout(() => {
			if (this.lastParams) {
				void this.runInView(this.lastParams);
			}
		}, this.searchOnTypeDelay);
	}

	/** Explicit search (Enter / button): run, then save if it was a valid query. */
	private async handleRun(params: SearchParams): Promise<void> {
		await this.runAndRecord(params);
	}

	/**
	 * Search-as-you-type run. Unlike a manual run there is no button to press, so
	 * once the debounce has settled on a query we treat it as intentional and save
	 * it to history automatically (the debounce keeps mid-keystroke fragments out).
	 */
	private async handlePreview(params: SearchParams): Promise<void> {
		await this.runAndRecord(params);
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

		await this.post({ type: 'searchStarted' });
		const maxMatches = vscode.workspace
			.getConfiguration('searchHistory')
			.get<number>('maxResults', DEFAULT_MAX_RESULTS);

		const outcome = await runSearch(params, {
			maxMatches,
			token: tokens.token,
			onFile: (file) => {
				if (!tokens.token.isCancellationRequested) {
					void this.post({ type: 'results', files: [toWireFile(file)] });
				}
			},
		});

		if (tokens.token.isCancellationRequested) {
			return undefined;
		}
		await this.post({ type: 'searchDone', ...outcome });
		return outcome;
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
		const nonce = makeNonce();
		const asset = (...parts: string[]) =>
			webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, ...parts));
		const styleUri = asset('media', 'searchBar.css');
		const scriptUri = asset('media', 'searchBar.js');
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${styleUri}" />
	<title>Search History</title>
</head>
<body>
	<div class="bar">
		<div class="query-row">
			<button id="toggleReplace" class="icon-btn chevron" type="button" title="Toggle Replace" aria-label="Toggle Replace" aria-pressed="false">&#8250;</button>
			<div class="field query-field">
				<input id="query" type="text" spellcheck="false" placeholder="Search" aria-label="Search query" />
				<div class="options">
					<button id="opt-case" class="option" type="button" title="Match Case" aria-label="Match Case" aria-pressed="false">Aa</button>
					<button id="opt-word" class="option" type="button" title="Match Whole Word" aria-label="Match Whole Word" aria-pressed="false"><span class="word">ab</span></button>
					<button id="opt-regex" class="option" type="button" title="Use Regular Expression" aria-label="Use Regular Expression" aria-pressed="false">.&#42;</button>
				</div>
			</div>
			<button id="toggleDetails" class="icon-btn details-btn" type="button" title="Toggle Search Details (files to include / exclude)" aria-label="Toggle Search Details" aria-pressed="false">&#8943;</button>
			<ul id="suggestions" class="suggestions" role="listbox" hidden></ul>
		</div>

		<div id="replaceRow" class="collapsible indented">
			<div class="collapsible-inner">
				<div class="field-row">
					<div class="field">
						<input id="replace" type="text" spellcheck="false" placeholder="Replace" aria-label="Replace" />
					</div>
				</div>
			</div>
		</div>

		<div id="detailsRow" class="collapsible indented">
			<div class="collapsible-inner">
				<label class="glob-label" for="include">Files to include</label>
				<div class="field-row">
					<div class="field">
						<input id="include" type="text" spellcheck="false" placeholder="e.g. src/**/*.ts" aria-label="Files to include" />
					</div>
				</div>
				<label class="glob-label" for="exclude">Files to exclude</label>
				<div class="field-row">
					<div class="field">
						<input id="exclude" type="text" spellcheck="false" placeholder="e.g. **/node_modules/**" aria-label="Files to exclude" />
					</div>
				</div>
			</div>
		</div>

		<div id="actions" class="actions indented">
			<button id="run" class="run" type="button">Search &amp; Save</button>
			<span class="hint">Press Enter to run</span>
		</div>
		<div id="typeHint" class="actions indented" hidden>
			<span class="hint">Searching as you type — saved automatically</span>
		</div>
	</div>

	<div id="status" class="status" hidden>
		<span id="statusText"></span>
		<button id="openNative" class="link-btn" type="button" title="Open this search in VS Code's Search panel" hidden>Open in VS Code Search</button>
	</div>
	<div id="results" class="results"></div>

	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function toWireFile(file: EngineFile): WireFile {
	return {
		uri: file.uri.toString(),
		path: file.relativePath,
		matches: file.matches.map((m) => ({
			line: m.line,
			column: m.column,
			endColumn: m.endColumn,
			preview: m.preview,
		})),
	};
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

function makeNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
