// The search bar's document shell.
//
// Kept apart from the view provider (and free of `vscode` imports beyond the
// URI type it is handed) so the markup contract — which controls exist, what
// they are called — can be asserted in tests. A missing Replace All button is a
// silent, invisible regression otherwise: the field is still there, it just
// does nothing.

// Note on icons: the webview's CSP allows no external resources, so VS Code's
// codicon font is out of reach. The buttons that need a glyph get a small inline
// SVG drawn by the client script (see `media/searchBar.js`), which keeps every
// icon's geometry in one place.

export interface SearchBarAssets {
	styleUri: string;
	scriptUri: string;
	/** Content-Security-Policy source for the webview's own resources. */
	cspSource: string;
	nonce: string;
}

/** Element ids the client script binds to; asserted by the UI contract test. */
export const CONTROL_IDS = [
	'query',
	'replace',
	'include',
	'exclude',
	'toggleReplace',
	'toggleDetails',
	'replaceAll',
	'run',
	'openNative',
	'results',
] as const;

export function buildSearchBarHtml({ styleUri, scriptUri, cspSource, nonce }: SearchBarAssets): string {
	const csp = [
		`default-src 'none'`,
		`style-src ${cspSource}`,
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
			<button id="toggleReplace" class="icon-btn chevron-btn" type="button" title="Toggle Replace" aria-label="Toggle Replace" aria-pressed="false"><span class="chevron-icon">&#8250;</span></button>
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
					<button id="replaceAll" class="icon-btn replace-all" type="button" title="Replace All (Enter · Ctrl+Alt+Enter)" aria-label="Replace All" disabled></button>
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

export function makeNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
