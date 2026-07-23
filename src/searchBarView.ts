import * as vscode from 'vscode';

import { type EngineFile, runSearch } from './searchEngine';
import type { HistoryStore } from './storage';
import type { SearchHistoryEntry, SearchParams } from './types';

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
	| { type: 'config'; searchOnType: boolean; delay: number }
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

	/** Explicit search (Enter / button): save to history, then run. */
	private async handleRun(params: SearchParams): Promise<void> {
		if (params.query.trim() === '') {
			return;
		}
		await this.deps.record(params);
		this.lastParamsSaved = true;
		await this.runInView(params);
	}

	/**
	 * Search-as-you-type run. Unlike a manual run there is no button to press, so
	 * once the debounce has settled on a query we treat it as intentional and save
	 * it to history automatically (the debounce keeps mid-keystroke fragments out).
	 */
	private async handlePreview(params: SearchParams): Promise<void> {
		if (params.query.trim() === '') {
			return;
		}
		await this.deps.record(params);
		this.lastParamsSaved = true;
		await this.runInView(params);
	}

	/** Run the search and stream results into the webview, cancelling any prior run. */
	private async runInView(params: SearchParams): Promise<void> {
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

		if (!tokens.token.isCancellationRequested) {
			await this.post({ type: 'searchDone', ...outcome });
		}
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
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta http-equiv="Content-Security-Policy" content="${csp}" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<style nonce="${nonce}">${STYLES}</style>
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

	<script nonce="${nonce}">${SCRIPT}</script>
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

// --- Webview assets (inlined to keep the extension dependency-free) ----------

const STYLES = /* css */ `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
/* A class rule like .field-row { display: flex } would otherwise beat the UA
   [hidden] { display: none }, so make hiding always win. */
[hidden] { display: none !important; }
html, body { height: 100%; }
body {
	margin: 0;
	padding: 8px 8px 0;
	display: flex;
	flex-direction: column;
	font-family: var(--vscode-font-family);
	font-size: var(--vscode-font-size);
	color: var(--vscode-foreground);
	background: var(--vscode-sideBar-background);
}
.bar { flex: 0 0 auto; display: flex; flex-direction: column; gap: 4px; }
.query-row { position: relative; display: flex; align-items: center; gap: 2px; }
.field-row { display: flex; }
.field {
	position: relative;
	display: flex;
	align-items: center;
	flex: 1 1 auto;
	background: var(--vscode-input-background);
	color: var(--vscode-input-foreground);
	border: 1px solid var(--vscode-input-border, transparent);
	border-radius: 2px;
	min-height: 26px;
}
.field:focus-within { border-color: var(--vscode-focusBorder); }
.field input {
	flex: 1 1 auto;
	min-width: 0;
	padding: 4px 6px;
	background: transparent;
	color: inherit;
	border: none;
	outline: none;
	font-family: inherit;
	font-size: inherit;
}
.field input::placeholder { color: var(--vscode-input-placeholderForeground); opacity: 1; }
.query-field { flex: 1 1 auto; }
.options { display: flex; align-items: center; gap: 2px; padding: 0 3px; }
.option {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	min-width: 20px;
	height: 20px;
	padding: 0 3px;
	font-family: inherit;
	font-size: 11px;
	line-height: 1;
	color: var(--vscode-input-foreground);
	background: transparent;
	border: 1px solid transparent;
	border-radius: 3px;
	cursor: pointer;
	opacity: 0.75;
	user-select: none;
}
.option:hover { background: var(--vscode-inputOption-hoverBackground); opacity: 1; }
.option[aria-pressed="true"] {
	opacity: 1;
	color: var(--vscode-inputOption-activeForeground);
	background: var(--vscode-inputOption-activeBackground);
	border-color: var(--vscode-inputOption-activeBorder);
}
.option .word { text-decoration: underline; }
.icon-btn {
	flex: 0 0 auto;
	display: inline-flex;
	align-items: center;
	justify-content: center;
	width: 20px;
	height: 24px;
	padding: 0;
	color: var(--vscode-foreground);
	background: transparent;
	border: 1px solid transparent;
	border-radius: 4px;
	cursor: pointer;
	opacity: 0.75;
}
.icon-btn:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
.chevron { font-size: 15px; transition: transform 0.12s ease; }
.chevron.expanded { transform: rotate(90deg); }
.details-btn { font-size: 16px; line-height: 1; }
.details-btn[aria-pressed="true"] {
	opacity: 1;
	color: var(--vscode-inputOption-activeForeground);
	background: var(--vscode-inputOption-activeBackground);
	border-color: var(--vscode-inputOption-activeBorder);
}
/* Collapsible sections (Replace, Search details) slide open/closed by animating
   the grid row from 0fr to 1fr — smooth without measuring content height. */
.collapsible {
	display: grid;
	grid-template-rows: 0fr;
	transition: grid-template-rows 0.18s ease;
}
.collapsible.open { grid-template-rows: 1fr; }
.collapsible > .collapsible-inner { overflow: hidden; min-height: 0; }
@media (prefers-reduced-motion: reduce) {
	.collapsible { transition: none; }
}

/* Align content under the query field, past the leading chevron (20px + gap). */
.indented { padding-left: 22px; }
.glob-label {
	display: block;
	margin: 6px 0 3px;
	color: var(--vscode-foreground);
	opacity: 0.9;
}
.actions { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
.run {
	padding: 4px 12px;
	color: var(--vscode-button-foreground);
	background: var(--vscode-button-background);
	border: 1px solid var(--vscode-button-border, transparent);
	border-radius: 2px;
	cursor: pointer;
	font-family: inherit;
	font-size: inherit;
}
.run:hover { background: var(--vscode-button-hoverBackground); }
.hint { font-size: 11px; opacity: 0.6; }
.suggestions {
	position: absolute;
	top: 28px;
	left: 22px;
	right: 22px;
	z-index: 10;
	margin: 0;
	padding: 2px;
	list-style: none;
	max-height: 220px;
	overflow-y: auto;
	background: var(--vscode-editorSuggestWidget-background, var(--vscode-dropdown-background));
	border: 1px solid var(--vscode-editorSuggestWidget-border, var(--vscode-dropdown-border, transparent));
	border-radius: 3px;
	box-shadow: 0 2px 8px rgba(0, 0, 0, 0.36);
}
.suggestions li {
	display: flex;
	align-items: baseline;
	gap: 6px;
	padding: 3px 6px;
	border-radius: 3px;
	cursor: pointer;
	white-space: nowrap;
	overflow: hidden;
}
.suggestions li:hover,
.suggestions li.active {
	color: var(--vscode-list-activeSelectionForeground);
	background: var(--vscode-list-activeSelectionBackground);
}
.suggestions .s-query { overflow: hidden; text-overflow: ellipsis; }
.suggestions .s-star { color: var(--vscode-charts-yellow, #d7b500); flex: 0 0 auto; }
.suggestions .s-meta { flex: 0 0 auto; margin-left: auto; font-size: 11px; opacity: 0.6; }

/* --- Results ------------------------------------------------------------- */
.status {
	flex: 0 0 auto;
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 10px;
	padding: 4px 2px;
	font-size: 12px;
	opacity: 0.85;
	border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
}
.status #statusText { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.link-btn {
	flex: 0 0 auto;
	padding: 0;
	color: var(--vscode-textLink-foreground);
	background: transparent;
	border: none;
	cursor: pointer;
	font-family: inherit;
	font-size: 11px;
	text-decoration: none;
}
.link-btn:hover { text-decoration: underline; }
.results { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
.file { user-select: none; }
.file-head {
	display: flex;
	align-items: center;
	gap: 4px;
	padding: 2px 2px;
	cursor: pointer;
	white-space: nowrap;
}
.file-head:hover { background: var(--vscode-list-hoverBackground); }
.file-twisty { flex: 0 0 auto; width: 12px; text-align: center; opacity: 0.8; font-size: 10px; }
.file-name { overflow: hidden; text-overflow: ellipsis; }
.file-count {
	flex: 0 0 auto;
	margin-left: 4px;
	min-width: 16px;
	height: 15px;
	padding: 0 4px;
	text-align: center;
	font-size: 10px;
	line-height: 15px;
	border-radius: 8px;
	color: var(--vscode-badge-foreground);
	background: var(--vscode-badge-background);
}
.match {
	display: flex;
	gap: 6px;
	padding: 1px 2px 1px 18px;
	cursor: pointer;
	white-space: pre;
	overflow: hidden;
}
.match:hover { background: var(--vscode-list-hoverBackground); }
.match .ln {
	flex: 0 0 auto;
	min-width: 34px;
	text-align: right;
	opacity: 0.5;
	font-variant-numeric: tabular-nums;
}
.match .mtext { overflow: hidden; text-overflow: ellipsis; font-family: var(--vscode-editor-font-family, monospace); }
.match .hl {
	color: var(--vscode-editor-findMatchHighlightForeground, inherit);
	background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
	border-radius: 2px;
}
`;

const SCRIPT = /* js */ `
const vscode = acquireVsCodeApi();

const $ = (id) => document.getElementById(id);
const els = {
	query: $('query'),
	replace: $('replace'),
	include: $('include'),
	exclude: $('exclude'),
	replaceRow: $('replaceRow'),
	detailsRow: $('detailsRow'),
	toggleReplace: $('toggleReplace'),
	toggleDetails: $('toggleDetails'),
	suggestions: $('suggestions'),
	optCase: $('opt-case'),
	optWord: $('opt-word'),
	optRegex: $('opt-regex'),
	run: $('run'),
	actions: $('actions'),
	typeHint: $('typeHint'),
	status: $('status'),
	statusText: $('statusText'),
	openNative: $('openNative'),
	results: $('results'),
};

const flags = { isCaseSensitive: false, matchWholeWord: false, isRegex: false };
let replaceVisible = false;
let detailsVisible = false;
let activeSuggestion = -1;
let suggestionItems = [];
let searchOnType = false;
let searchOnTypeDelay = 300;
let typeTimer;

// Restore any state kept across webview reloads.
const saved = vscode.getState();
if (saved) {
	els.query.value = saved.query || '';
	els.replace.value = saved.replaceText || '';
	els.include.value = saved.filesToInclude || '';
	els.exclude.value = saved.filesToExclude || '';
	flags.isCaseSensitive = !!saved.isCaseSensitive;
	flags.matchWholeWord = !!saved.matchWholeWord;
	flags.isRegex = !!saved.isRegex;
	replaceVisible = !!saved.replaceVisible;
	detailsVisible = !!saved.detailsVisible;
}

function persist() {
	vscode.setState({ ...collect(), replaceVisible, detailsVisible });
}

function collect() {
	return {
		query: els.query.value,
		replaceText: els.replace.value,
		filesToInclude: els.include.value,
		filesToExclude: els.exclude.value,
		isCaseSensitive: flags.isCaseSensitive,
		matchWholeWord: flags.matchWholeWord,
		isRegex: flags.isRegex,
	};
}

function renderFlags() {
	els.optCase.setAttribute('aria-pressed', String(flags.isCaseSensitive));
	els.optWord.setAttribute('aria-pressed', String(flags.matchWholeWord));
	els.optRegex.setAttribute('aria-pressed', String(flags.isRegex));
}

function renderReplace() {
	els.replaceRow.classList.toggle('open', replaceVisible);
	els.toggleReplace.classList.toggle('expanded', replaceVisible);
	els.toggleReplace.setAttribute('aria-pressed', String(replaceVisible));
}

function renderDetails() {
	els.detailsRow.classList.toggle('open', detailsVisible);
	els.toggleDetails.setAttribute('aria-pressed', String(detailsVisible));
}

// In search-as-you-type mode there is nothing to press: the Search & Save button
// and its "Press Enter" hint are hidden, and a passive hint takes their place.
function applyConfig() {
	els.actions.hidden = searchOnType;
	els.typeHint.hidden = !searchOnType;
}

function bindToggle(el, key) {
	el.addEventListener('click', () => {
		flags[key] = !flags[key];
		renderFlags();
		persist();
		schedulePreview();
		els.query.focus();
	});
}
bindToggle(els.optCase, 'isCaseSensitive');
bindToggle(els.optWord, 'matchWholeWord');
bindToggle(els.optRegex, 'isRegex');

els.toggleReplace.addEventListener('click', () => {
	replaceVisible = !replaceVisible;
	renderReplace();
	persist();
	if (replaceVisible) els.replace.focus();
});

els.toggleDetails.addEventListener('click', () => {
	detailsVisible = !detailsVisible;
	renderDetails();
	persist();
	if (detailsVisible) els.include.focus();
});

function submit(save) {
	const state = collect();
	if (state.query.trim() === '') { if (save) els.query.focus(); return; }
	clearTimeout(typeTimer);
	hideSuggestions();
	vscode.postMessage({ type: save ? 'run' : 'preview', params: {
		query: state.query,
		replaceText: state.replaceText,
		filesToInclude: state.filesToInclude,
		filesToExclude: state.filesToExclude,
		isRegex: state.isRegex,
		isCaseSensitive: state.isCaseSensitive,
		matchWholeWord: state.matchWholeWord,
	}});
}

function schedulePreview() {
	if (!searchOnType) return;
	clearTimeout(typeTimer);
	if (els.query.value.trim() === '') { clearResultsUI(); return; }
	typeTimer = setTimeout(() => submit(false), searchOnTypeDelay);
}

els.run.addEventListener('click', () => submit(true));
els.openNative.addEventListener('click', () => vscode.postMessage({ type: 'openInNative' }));

for (const input of [els.query, els.replace, els.include, els.exclude]) {
	input.addEventListener('input', persist);
	input.addEventListener('keydown', (e) => {
		if (e.key === 'Enter') { e.preventDefault(); submit(true); }
	});
}
for (const input of [els.include, els.exclude]) {
	input.addEventListener('input', schedulePreview);
}

// --- Suggestions -----------------------------------------------------------

let suggestTimer;
els.query.addEventListener('input', () => {
	clearTimeout(suggestTimer);
	suggestTimer = setTimeout(() => {
		vscode.postMessage({ type: 'requestSuggestions', query: els.query.value });
	}, 90);
	schedulePreview();
});
els.query.addEventListener('focus', () => {
	vscode.postMessage({ type: 'requestSuggestions', query: els.query.value });
});
els.query.addEventListener('keydown', (e) => {
	if (els.suggestions.hidden) return;
	if (e.key === 'ArrowDown') { e.preventDefault(); moveActive(1); }
	else if (e.key === 'ArrowUp') { e.preventDefault(); moveActive(-1); }
	else if (e.key === 'Escape') { hideSuggestions(); }
	else if (e.key === 'Enter' && activeSuggestion >= 0) {
		e.preventDefault();
		applySuggestion(suggestionItems[activeSuggestion]);
	}
});
document.addEventListener('click', (e) => {
	if (!els.suggestions.contains(e.target) && e.target !== els.query) hideSuggestions();
});

function moveActive(delta) {
	if (suggestionItems.length === 0) return;
	activeSuggestion = (activeSuggestion + delta + suggestionItems.length) % suggestionItems.length;
	for (const [i, li] of [...els.suggestions.children].entries()) {
		li.classList.toggle('active', i === activeSuggestion);
	}
}

function hideSuggestions() {
	els.suggestions.hidden = true;
	els.suggestions.replaceChildren();
	activeSuggestion = -1;
	suggestionItems = [];
}

function applySuggestion(item) {
	if (!item) return;
	els.query.value = item.query;
	els.replace.value = item.replaceText || '';
	els.include.value = item.filesToInclude || '';
	els.exclude.value = item.filesToExclude || '';
	flags.isCaseSensitive = !!item.isCaseSensitive;
	flags.matchWholeWord = !!item.matchWholeWord;
	flags.isRegex = !!item.isRegex;
	if ((item.replaceText || '') !== '' && !replaceVisible) { replaceVisible = true; renderReplace(); }
	if (((item.filesToInclude || '') !== '' || (item.filesToExclude || '') !== '') && !detailsVisible) {
		detailsVisible = true; renderDetails();
	}
	renderFlags();
	persist();
	hideSuggestions();
	els.query.focus();
}

function renderSuggestions(items) {
	suggestionItems = items;
	activeSuggestion = -1;
	els.suggestions.replaceChildren();
	if (items.length === 0) { els.suggestions.hidden = true; return; }
	for (const item of items) {
		const li = document.createElement('li');
		li.setAttribute('role', 'option');
		if (item.favorite) {
			const star = document.createElement('span');
			star.className = 's-star';
			star.textContent = '★';
			li.appendChild(star);
		}
		const q = document.createElement('span');
		q.className = 's-query';
		q.textContent = item.query;
		li.appendChild(q);
		const meta = document.createElement('span');
		meta.className = 's-meta';
		meta.textContent = flagLabel(item);
		li.appendChild(meta);
		li.addEventListener('click', () => applySuggestion(item));
		els.suggestions.appendChild(li);
	}
	els.suggestions.hidden = false;
}

function flagLabel(item) {
	const parts = [];
	if (item.isRegex) parts.push('.*');
	if (item.isCaseSensitive) parts.push('Aa');
	if (item.matchWholeWord) parts.push('ab');
	return parts.join(' ');
}

// --- Results ---------------------------------------------------------------

function clearResults() {
	els.results.replaceChildren();
}

function clearResultsUI() {
	els.results.replaceChildren();
	els.status.hidden = true;
	els.openNative.hidden = true;
}

function renderFile(file) {
	const wrap = document.createElement('div');
	wrap.className = 'file';

	const head = document.createElement('div');
	head.className = 'file-head';
	const twisty = document.createElement('span');
	twisty.className = 'file-twisty';
	twisty.textContent = '▾';
	const name = document.createElement('span');
	name.className = 'file-name';
	name.textContent = file.path;
	name.title = file.path;
	const count = document.createElement('span');
	count.className = 'file-count';
	count.textContent = String(file.matches.length);
	head.append(twisty, name, count);

	const body = document.createElement('div');
	body.className = 'file-matches';

	// Group occurrences by line so a line with several hits renders once.
	const byLine = new Map();
	for (const m of file.matches) {
		if (!byLine.has(m.line)) byLine.set(m.line, { preview: m.preview, ranges: [] });
		byLine.get(m.line).ranges.push([m.column, m.endColumn]);
	}
	for (const [line, info] of byLine) {
		body.appendChild(renderMatchLine(file, line, info));
	}

	head.addEventListener('click', () => {
		const collapsed = body.hidden;
		body.hidden = !collapsed;
		twisty.textContent = collapsed ? '▾' : '▸';
	});

	wrap.append(head, body);
	return wrap;
}

function renderMatchLine(file, line, info) {
	const row = document.createElement('div');
	row.className = 'match';
	const ln = document.createElement('span');
	ln.className = 'ln';
	ln.textContent = String(line);
	const text = document.createElement('span');
	text.className = 'mtext';
	appendHighlighted(text, info.preview, info.ranges);
	row.append(ln, text);
	const first = info.ranges[0];
	row.addEventListener('click', () => {
		vscode.postMessage({ type: 'openMatch', uri: file.uri, line, column: first[0], endColumn: first[1] });
	});
	return row;
}

function appendHighlighted(container, preview, ranges) {
	// Trim leading indentation for display while keeping click offsets accurate.
	const lead = preview.length - preview.trimStart().length;
	const display = preview.slice(lead);
	const sorted = ranges
		.map(([s, e]) => [Math.max(0, s - lead), Math.max(0, e - lead)])
		.filter(([s, e]) => e > s)
		.sort((a, b) => a[0] - b[0]);

	let cursor = 0;
	for (const [s, e] of sorted) {
		if (s < cursor) continue; // overlapping/duplicate range
		if (s > cursor) container.appendChild(document.createTextNode(display.slice(cursor, s)));
		const mark = document.createElement('span');
		mark.className = 'hl';
		mark.textContent = display.slice(s, e);
		container.appendChild(mark);
		cursor = e;
	}
	if (cursor < display.length) container.appendChild(document.createTextNode(display.slice(cursor)));
}

// --- Host messages ---------------------------------------------------------

window.addEventListener('message', (event) => {
	const msg = event.data;
	switch (msg.type) {
		case 'suggestions': renderSuggestions(msg.items); break;
		case 'focus': els.query.focus(); els.query.select(); break;
		case 'config':
			searchOnType = !!msg.searchOnType;
			searchOnTypeDelay = msg.delay || 300;
			applyConfig();
			break;
		case 'prefill': applySuggestion({ ...msg.params, favorite: false }); els.query.focus(); break;
		case 'searchStarted':
			clearResults();
			els.status.hidden = false;
			els.openNative.hidden = false;
			els.statusText.textContent = 'Searching…';
			break;
		case 'results':
			for (const file of msg.files) els.results.appendChild(renderFile(file));
			break;
		case 'searchDone':
			els.statusText.textContent = summarize(msg);
			break;
	}
});

function summarize(msg) {
	if (msg.error) return msg.error;
	if (msg.matchCount === 0) return 'No results found';
	const results = msg.matchCount + (msg.matchCount === 1 ? ' result' : ' results');
	const files = msg.fileCount + (msg.fileCount === 1 ? ' file' : ' files');
	return results + ' in ' + files + (msg.truncated ? ' (showing first ' + msg.matchCount + ')' : '');
}

renderFlags();
renderReplace();
renderDetails();
applyConfig();
els.query.focus();
vscode.postMessage({ type: 'ready' });
`;
