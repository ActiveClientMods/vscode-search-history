// Client script for the Search History search bar webview. Loaded from disk via
// a nonce'd <script src> (see SearchBarViewProvider.getHtml). Plain browser JS —
// it runs in the webview, not the extension host, so it has no `vscode` module,
// only the `acquireVsCodeApi` bridge.

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
let showSuggestions = false;
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
			showSuggestions = !!msg.showSuggestions;
			if (!showSuggestions) hideSuggestions();
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
