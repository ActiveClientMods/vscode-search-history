// Client script for the Search History search bar webview. Loaded from disk via
// a nonce'd <script src> (see buildSearchBarHtml). Plain browser JS — it runs in
// the webview, not the extension host, so it has no `vscode` module, only the
// `acquireVsCodeApi` bridge.
//
// It is deliberately thin: the host sends result lines already grouped, already
// windowed around their match and already carrying their replacement preview,
// so everything below is either event wiring or DOM assembly.

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
	replaceAll: $('replaceAll'),
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
let showSuggestions = false;
let typeTimer;
// How flipping a match option (Match Case / Whole Word / Regex) behaves, both
// user-configurable: whether it re-runs the search, and whether that re-run is
// also saved to history (the latter only applies when re-running is on).
let rerunOnOptionToggle = true;
let saveOnOptionToggle = true;
let replaceTextTimer;
let hasResults = false;

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

// Replacing is only meaningful once a search has produced something to replace.
function renderReplaceEnabled() {
	els.replaceAll.disabled = !hasResults;
	els.results.classList.toggle('replacing', els.replace.value !== '');
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
		runFromFlagChange();
		els.query.focus();
	});
}

// What flipping Match Case / Whole Word / Regex does is user-configurable:
//   • rerunOnOptionToggle off → just update the flag (run manually with Enter/button)
//   • on + saveOnOptionToggle on  → re-run and save the search with the new options
//   • on + saveOnOptionToggle off → re-run only; the user saves it manually
function runFromFlagChange() {
	if (!rerunOnOptionToggle) return;
	if (els.query.value.trim() === '') return;
	if (saveOnOptionToggle) submit(true);
	else runNoSave();
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

function paramsFromState(state) {
	return {
		query: state.query,
		replaceText: state.replaceText,
		filesToInclude: state.filesToInclude,
		filesToExclude: state.filesToExclude,
		isRegex: state.isRegex,
		isCaseSensitive: state.isCaseSensitive,
		matchWholeWord: state.matchWholeWord,
	};
}

function submit(save) {
	const state = collect();
	if (state.query.trim() === '') { if (save) els.query.focus(); return; }
	clearTimeout(typeTimer);
	hideSuggestions();
	vscode.postMessage({ type: save ? 'run' : 'preview', params: paramsFromState(state) });
}

// Run the current search but do not save it to history — used by a match-option
// toggle when re-running is on but saving toggled runs is off.
function runNoSave() {
	const state = collect();
	if (state.query.trim() === '') return;
	clearTimeout(typeTimer);
	hideSuggestions();
	vscode.postMessage({ type: 'runNoSave', params: paramsFromState(state) });
}

function schedulePreview() {
	if (!searchOnType) return;
	clearTimeout(typeTimer);
	if (els.query.value.trim() === '') { clearResultsUI(); return; }
	typeTimer = setTimeout(() => submit(false), searchOnTypeDelay);
}

// The replacement text is only sent to the host after a short debounce, so
// typing one and pressing Enter straight away would replace with whatever the
// host last heard — often nothing at all. Every replace action flushes it first;
// messages arrive in order, so the host always has the current text.
function flushReplaceText() {
	clearTimeout(replaceTextTimer);
	vscode.postMessage({ type: 'replaceTextChanged', replaceText: els.replace.value });
}

function requestReplaceAll() {
	if (!hasResults) { els.query.focus(); return; }
	flushReplaceText();
	vscode.postMessage({ type: 'replaceAll' });
}

els.run.addEventListener('click', () => submit(true));
els.replaceAll.addEventListener('click', requestReplaceAll);
// Re-running the visible results is the search bar's own title-bar Refresh
// action (searchHistory.refreshSearch), which reloads the history list too.
els.openNative.addEventListener('click', () => vscode.postMessage({ type: 'openInNative' }));

for (const input of [els.query, els.replace, els.include, els.exclude]) {
	input.addEventListener('input', persist);
	input.addEventListener('keydown', (e) => {
		if (e.key !== 'Enter') return;
		// An open suggestion list owns Enter (handled by its own listener below).
		if (input === els.query && !els.suggestions.hidden && activeSuggestion >= 0) return;
		e.preventDefault();
		// Enter inside the Replace field replaces — searching again from there was
		// the one thing it could never usefully mean.
		if (input === els.replace || e.ctrlKey || e.metaKey || e.altKey) requestReplaceAll();
		else submit(true);
	});
}
for (const input of [els.include, els.exclude]) {
	input.addEventListener('input', schedulePreview);
}

// Editing the replacement changes only what the inline preview shows, so ask the
// host to re-render the results it already has rather than searching again.
els.replace.addEventListener('input', () => {
	renderReplaceEnabled();
	clearTimeout(replaceTextTimer);
	replaceTextTimer = setTimeout(() => {
		vscode.postMessage({ type: 'replaceTextChanged', replaceText: els.replace.value });
	}, 200);
});

// --- Suggestions -----------------------------------------------------------

let suggestTimer;
els.query.addEventListener('input', () => {
	if (showSuggestions) {
		clearTimeout(suggestTimer);
		suggestTimer = setTimeout(() => {
			vscode.postMessage({ type: 'requestSuggestions', query: els.query.value });
		}, 90);
	}
	schedulePreview();
});
els.query.addEventListener('focus', () => {
	if (showSuggestions) {
		vscode.postMessage({ type: 'requestSuggestions', query: els.query.value });
	}
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
	renderReplaceEnabled();
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
	hasResults = false;
	renderReplaceEnabled();
}

function clearResultsUI() {
	clearResults();
	els.status.hidden = true;
	els.openNative.hidden = true;
}

// Wipe every input field and the results; backs the "Clear Search" title action.
function clearInputs() {
	els.query.value = '';
	els.replace.value = '';
	els.include.value = '';
	els.exclude.value = '';
	clearTimeout(typeTimer);
	clearTimeout(replaceTextTimer);
	hideSuggestions();
	clearResultsUI();
	renderReplaceEnabled();
	persist();
	els.query.focus();
}

// Reset the three match options without firing a search; backs "Clear Match Options".
function clearOptions() {
	flags.isCaseSensitive = false;
	flags.matchWholeWord = false;
	flags.isRegex = false;
	renderFlags();
	persist();
	els.query.focus();
}

// --- Icons -----------------------------------------------------------------
//
// The CSP allows the webview no external resources, so VS Code's codicon font is
// unavailable and the replace actions draw their own glyphs. Both read the same
// way as the native ones: a source box, an arrow, and the filled replacement —
// with two source boxes when the action covers every match.

const SVG_NS = 'http://www.w3.org/2000/svg';
const OUTLINE = { rx: 1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 };
const ARROW_TO_REPLACEMENT = [
	['path', { d: 'M5.8 8H9.4', fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2 }],
	['path', { d: 'M8.9 6.2L11.3 8L8.9 9.8Z', fill: 'currentColor' }],
	['rect', { x: 11.5, y: 5.5, width: 4, height: 5, rx: 1, fill: 'currentColor' }],
];
const ICON_REPLACE = [['rect', { x: 0.6, y: 5.5, width: 4.6, height: 5, ...OUTLINE }], ...ARROW_TO_REPLACEMENT];
const ICON_REPLACE_ALL = [
	['rect', { x: 0.6, y: 1, width: 4.6, height: 4.6, ...OUTLINE }],
	['rect', { x: 0.6, y: 10.4, width: 4.6, height: 4.6, ...OUTLINE }],
	...ARROW_TO_REPLACEMENT,
];

function svgIcon(shapes) {
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.setAttribute('viewBox', '0 0 16 16');
	svg.setAttribute('width', '14');
	svg.setAttribute('height', '14');
	svg.setAttribute('aria-hidden', 'true');
	svg.setAttribute('focusable', 'false');
	for (const [tag, attrs] of shapes) {
		const node = document.createElementNS(SVG_NS, tag);
		for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
		svg.appendChild(node);
	}
	return svg;
}

// A discrete icon button: the label lives in the tooltip, like every other
// button in the bar, so a narrow sidebar is not dominated by a word.
function makeIconButton(className, icon, title, onClick) {
	const button = document.createElement('button');
	button.type = 'button';
	button.className = className;
	button.title = title;
	button.setAttribute('aria-label', title);
	button.appendChild(svgIcon(icon));
	button.addEventListener('click', (e) => {
		e.stopPropagation(); // never open the file / collapse the group as a side effect
		onClick();
	});
	return button;
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
	count.textContent = String(file.matchCount);
	const replaceInFile = makeIconButton(
		'icon-btn row-action',
		ICON_REPLACE_ALL,
		'Replace every match in this file',
		() => { flushReplaceText(); vscode.postMessage({ type: 'replaceFile', uri: file.uri }); },
	);
	head.append(twisty, name, replaceInFile, count);

	const body = document.createElement('div');
	body.className = 'file-matches';
	for (const line of file.lines) {
		body.appendChild(renderMatchLine(file, line));
	}

	head.addEventListener('click', () => {
		const collapsed = body.hidden;
		body.hidden = !collapsed;
		twisty.textContent = collapsed ? '▾' : '▸';
	});
	head.addEventListener('contextmenu', (e) =>
		openResultMenu(e, { kind: 'file', uri: file.uri, path: file.path, node: wrap }),
	);

	wrap.append(head, body);
	return wrap;
}

function renderMatchLine(file, line) {
	const row = document.createElement('div');
	row.className = 'match';

	const ln = document.createElement('span');
	ln.className = 'ln';
	ln.textContent = String(line.line);

	const text = document.createElement('span');
	text.className = 'mtext';
	appendLine(text, line);

	const count = line.matches.length;
	const action = makeIconButton(
		'icon-btn row-action',
		count === 1 ? ICON_REPLACE : ICON_REPLACE_ALL,
		count === 1 ? 'Replace this match' : `Replace ${count} matches on this line`,
		() => {
			flushReplaceText();
			vscode.postMessage({ type: 'replaceMatches', uri: file.uri, matches: line.matches });
		},
	);

	row.append(ln, text, action);
	const first = line.matches[0];
	row.addEventListener('click', () => {
		vscode.postMessage({
			type: 'openMatch',
			uri: file.uri,
			line: line.line,
			column: first.column,
			endColumn: first.endColumn,
		});
	});
	row.addEventListener('contextmenu', (e) =>
		openResultMenu(e, {
			kind: 'match',
			uri: file.uri,
			path: file.path,
			node: row,
			line: line.line,
			lineText: line.text,
		}),
	);
	return row;
}

// The host has already dropped indentation and windowed the line around its
// first match, so a hit at column 300 is visible without scrolling; the elision
// flags say whether text was cut off on either side.
function appendLine(container, line) {
	if (line.leadingElided) container.appendChild(ellipsis());
	let cursor = 0;
	for (const hl of line.highlights) {
		if (hl.start < cursor) continue; // overlapping/duplicate range
		if (hl.start > cursor) container.appendChild(document.createTextNode(line.text.slice(cursor, hl.start)));
		const mark = document.createElement('span');
		mark.className = 'hl';
		mark.textContent = line.text.slice(hl.start, hl.end);
		container.appendChild(mark);
		if (hl.replacement !== undefined && hl.replacement !== null) {
			mark.classList.add('replaced');
			const added = document.createElement('span');
			added.className = 'hl added';
			added.textContent = hl.replacement;
			container.appendChild(added);
		}
		cursor = hl.end;
	}
	if (cursor < line.text.length) container.appendChild(document.createTextNode(line.text.slice(cursor)));
	if (line.trailingElided) container.appendChild(ellipsis());
}

function ellipsis() {
	const span = document.createElement('span');
	span.className = 'elided';
	span.textContent = '…';
	span.title = 'Line trimmed so the match stays visible';
	return span;
}

// --- Context menu ----------------------------------------------------------
//
// Right-clicking a result opens a small menu mirroring the useful entries from
// VS Code's Search view (Replace All, Dismiss, include/exclude by file type, and
// the copy actions). The webview can't use VS Code's native menu, so this is a
// plain floating element, dismissed on the next click, scroll, Escape or blur.

let ctxMenu;

function ensureCtxMenu() {
	if (!ctxMenu) {
		ctxMenu = document.createElement('div');
		ctxMenu.className = 'ctx-menu';
		ctxMenu.hidden = true;
		document.body.appendChild(ctxMenu);
	}
	return ctxMenu;
}

function hideCtxMenu() {
	if (ctxMenu) {
		ctxMenu.hidden = true;
		ctxMenu.replaceChildren();
	}
}

function ctxItem(label, shortcut, onClick) {
	const item = document.createElement('button');
	item.type = 'button';
	item.className = 'ctx-item';
	const text = document.createElement('span');
	text.textContent = label;
	item.appendChild(text);
	if (shortcut) {
		const sc = document.createElement('span');
		sc.className = 'ctx-shortcut';
		sc.textContent = shortcut;
		item.appendChild(sc);
	}
	item.addEventListener('click', (e) => {
		e.stopPropagation();
		hideCtxMenu();
		onClick();
	});
	return item;
}

function ctxSeparator() {
	const sep = document.createElement('div');
	sep.className = 'ctx-sep';
	return sep;
}

function fileExt(p) {
	const base = p.split(/[\\/]/).pop() || '';
	const dot = base.lastIndexOf('.');
	return dot > 0 ? base.slice(dot + 1) : '';
}

// Add a glob to the include/exclude field (unless already present) and re-run.
function addGlobAndRun(input, glob) {
	const parts = input.value.split(',').map((s) => s.trim()).filter(Boolean);
	if (!parts.includes(glob)) parts.push(glob);
	input.value = parts.join(', ');
	if (!detailsVisible) { detailsVisible = true; renderDetails(); }
	persist();
	submit(true);
}

// Remove a result from the view — the file on disk is untouched, but the host
// has to forget it too, or Replace All would still rewrite the dismissed match
// and the indices it sends for new rows would no longer line up with the list.
function dismissResult(ctx) {
	vscode.postMessage({ type: 'dismiss', uri: ctx.uri, line: ctx.kind === 'match' ? ctx.line : undefined });
	const node = ctx.node;
	const fileWrap = node.classList.contains('file') ? node : node.closest('.file');
	node.remove();
	if (fileWrap && fileWrap.isConnected && fileWrap.querySelectorAll('.match').length === 0) {
		fileWrap.remove();
	}
	if (els.results.querySelectorAll('.match').length === 0) {
		hasResults = false;
		renderReplaceEnabled();
	}
}

function openResultMenu(e, ctx) {
	e.preventDefault();
	e.stopPropagation();
	const menu = ensureCtxMenu();
	menu.replaceChildren();
	menu.appendChild(ctxItem('Replace All', 'Ctrl+Shift+1', requestReplaceAll));
	menu.appendChild(ctxItem('Dismiss', 'Del', () => dismissResult(ctx)));
	const ext = fileExt(ctx.path);
	if (ext) {
		menu.appendChild(ctxItem('Exclude File Type from Search', '', () => addGlobAndRun(els.exclude, '*.' + ext)));
		menu.appendChild(ctxItem('Include File Type from Search', '', () => addGlobAndRun(els.include, '*.' + ext)));
	}
	menu.appendChild(ctxSeparator());
	const copyText = ctx.kind === 'match' ? ctx.lineText : ctx.path;
	menu.appendChild(ctxItem('Copy', 'Ctrl+C', () => vscode.postMessage({ type: 'copyText', text: copyText })));
	menu.appendChild(ctxItem('Copy Path', 'Shift+Alt+C', () => vscode.postMessage({ type: 'copyPath', uri: ctx.uri })));
	menu.appendChild(ctxItem('Copy All', '', () => vscode.postMessage({ type: 'copyAll' })));

	menu.hidden = false;
	const rect = menu.getBoundingClientRect();
	menu.style.left = Math.max(2, Math.min(e.clientX, window.innerWidth - rect.width - 4)) + 'px';
	menu.style.top = Math.max(2, Math.min(e.clientY, window.innerHeight - rect.height - 4)) + 'px';
}

document.addEventListener('click', hideCtxMenu);
document.addEventListener('contextmenu', hideCtxMenu); // a right-click elsewhere closes ours
document.addEventListener('scroll', hideCtxMenu, true);
window.addEventListener('blur', hideCtxMenu);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideCtxMenu(); });

// --- Host messages ---------------------------------------------------------

window.addEventListener('message', (event) => {
	const msg = event.data;
	switch (msg.type) {
		case 'suggestions': renderSuggestions(msg.items); break;
		case 'focus': els.query.focus(); els.query.select(); break;
		case 'config':
			searchOnType = !!msg.searchOnType;
			searchOnTypeDelay = msg.delay || 300;
			showSuggestions = !!msg.showSuggestions;
			rerunOnOptionToggle = !!msg.rerunOnOptionToggle;
			saveOnOptionToggle = !!msg.saveOnOptionToggle;
			if (!showSuggestions) hideSuggestions();
			applyConfig();
			break;
		case 'prefill': applySuggestion({ ...msg.params, favorite: false }); els.query.focus(); break;
		case 'clearInputs': clearInputs(); break;
		case 'clearOptions': clearOptions(); break;
		case 'searchStarted':
			clearResults();
			els.status.hidden = false;
			els.openNative.hidden = false;
			els.statusText.textContent = 'Searching…';
			break;
		case 'results':
			// Files arrive as the engine finishes them, in no particular order, but
			// each carries the slot it occupies in the path-sorted list — so splice
			// it in there rather than appending it.
			for (const file of msg.files) {
				els.results.insertBefore(renderFile(file), els.results.children[file.index] || null);
				if (file.matchCount > 0) hasResults = true;
			}
			renderReplaceEnabled();
			break;
		case 'searchDone':
			els.statusText.textContent = summarize(msg);
			hasResults = msg.matchCount > 0 && !msg.error;
			renderReplaceEnabled();
			break;
		case 'replaceDone':
			els.statusText.textContent = msg.message;
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

els.replaceAll.appendChild(svgIcon(ICON_REPLACE_ALL));
renderFlags();
renderReplace();
renderDetails();
renderReplaceEnabled();
applyConfig();
els.query.focus();
vscode.postMessage({ type: 'ready' });
