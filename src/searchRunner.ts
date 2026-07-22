import * as vscode from 'vscode';

import type { HistoryStore } from './storage';
import type { SearchHistoryEntry, SearchParams } from './types';
import { currentWorkspace } from './workspace';

/**
 * Trigger VS Code's native "Find in Files" search pre-filled with the exact
 * query, flags and include/exclude patterns of the given parameters.
 */
export async function triggerNativeSearch(params: SearchParams): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.findInFiles', {
		query: params.query,
		replace: '',
		triggerSearch: true,
		isRegex: params.isRegex,
		isCaseSensitive: params.isCaseSensitive,
		matchWholeWord: params.matchWholeWord,
		filesToInclude: params.filesToInclude,
		filesToExclude: params.filesToExclude,
	});
}

/** Run a stored entry: launch the native search and record the usage. */
export async function runEntry(store: HistoryStore, entry: SearchHistoryEntry): Promise<void> {
	await triggerNativeSearch(entry);
	await store.touch(entry.id);
}

interface Flags {
	isRegex: boolean;
	isCaseSensitive: boolean;
	matchWholeWord: boolean;
}

// A saturated accent for active flags and a muted tone for inactive ones, so the
// on/off state of each toggle is legible at a glance (the QuickInput button API
// offers no "active background", unlike the native Search widget).
const ACTIVE_COLOR = new vscode.ThemeColor('charts.green');
const INACTIVE_COLOR = new vscode.ThemeColor('disabledForeground');

function flagButton(icon: string, label: string, active: boolean): vscode.QuickInputButton {
	return {
		iconPath: new vscode.ThemeIcon(icon, active ? ACTIVE_COLOR : INACTIVE_COLOR),
		tooltip: `${label} (${active ? 'on' : 'off'})`,
	};
}

function flagButtons(flags: Flags): vscode.QuickInputButton[] {
	return [
		flagButton('case-sensitive', 'Match Case', flags.isCaseSensitive),
		flagButton('whole-word', 'Match Whole Word', flags.matchWholeWord),
		flagButton('regex', 'Use Regular Expression', flags.isRegex),
	];
}

/** Always-visible, plain-text summary of the current flag state for the prompt line. */
function flagSummary(flags: Flags): string {
	const mark = (on: boolean) => (on ? '● on' : '○ off');
	return (
		`Regex ${mark(flags.isRegex)}   ·   ` +
		`Match Case ${mark(flags.isCaseSensitive)}   ·   ` +
		`Whole Word ${mark(flags.matchWholeWord)}`
	);
}

/**
 * Prompt for a query with native-search-style toggle buttons for the flags. The
 * buttons for Match Case / Whole Word / Regex mirror VS Code's own search box;
 * active ones are tinted and the prompt echoes their on/off state in words.
 * Resolves to the query + flags, or undefined if cancelled.
 */
function promptQueryWithFlags(seed?: SearchParams): Promise<(SearchParams & Flags) | undefined> {
	return new Promise((resolve) => {
		const flags: Flags = {
			isRegex: seed?.isRegex ?? false,
			isCaseSensitive: seed?.isCaseSensitive ?? false,
			matchWholeWord: seed?.matchWholeWord ?? false,
		};

		const input = vscode.window.createInputBox();
		input.title = 'New Search — enter query';
		input.placeholder = 'Search query (toggle Aa / ab / .* for Match Case, Whole Word, Regex)';
		input.value = seed?.query ?? '';
		input.ignoreFocusOut = true;

		const render = () => {
			input.buttons = flagButtons(flags);
			input.prompt = `${flagSummary(flags)}   —   press Enter to continue`;
		};
		render();

		let resolved = false;
		const finish = (result: (SearchParams & Flags) | undefined) => {
			if (resolved) {
				return;
			}
			resolved = true;
			input.dispose();
			resolve(result);
		};

		input.onDidTriggerButton((button) => {
			const tip = String(button.tooltip ?? '');
			if (tip.startsWith('Match Case')) {
				flags.isCaseSensitive = !flags.isCaseSensitive;
			} else if (tip.startsWith('Match Whole Word')) {
				flags.matchWholeWord = !flags.matchWholeWord;
			} else if (tip.startsWith('Use Regular Expression')) {
				flags.isRegex = !flags.isRegex;
			}
			render();
		});

		input.onDidAccept(() => {
			const query = input.value;
			if (query.trim() === '') {
				input.validationMessage = 'The query cannot be empty.';
				return;
			}
			finish({
				query,
				filesToInclude: seed?.filesToInclude ?? '',
				filesToExclude: seed?.filesToExclude ?? '',
				...flags,
			});
		});

		input.onDidHide(() => finish(undefined));
		input.show();
	});
}

async function promptPattern(title: string, placeholder: string, value: string): Promise<string | undefined> {
	return vscode.window.showInputBox({
		title,
		placeHolder: placeholder,
		value,
		ignoreFocusOut: true,
	});
}

/**
 * Full "New Search" flow: compose a query with flags and include/exclude
 * patterns, persist it to history, then launch the native search. Returns the
 * saved entry, or undefined when the user cancels at any step.
 */
export async function composeAndRun(store: HistoryStore): Promise<SearchHistoryEntry | undefined> {
	const base = await promptQueryWithFlags();
	if (!base) {
		return undefined;
	}

	const filesToInclude = await promptPattern(
		'New Search — files to include (optional)',
		'e.g. src/**/*.ts  (leave empty for all files)',
		base.filesToInclude,
	);
	if (filesToInclude === undefined) {
		return undefined;
	}

	const filesToExclude = await promptPattern(
		'New Search — files to exclude (optional)',
		'e.g. **/node_modules/**',
		base.filesToExclude,
	);
	if (filesToExclude === undefined) {
		return undefined;
	}

	const ws = currentWorkspace();
	const entry = await store.record({
		query: base.query,
		isRegex: base.isRegex,
		isCaseSensitive: base.isCaseSensitive,
		matchWholeWord: base.matchWholeWord,
		filesToInclude,
		filesToExclude,
		workspaceId: ws.id,
		workspaceName: ws.name,
	});

	await triggerNativeSearch(entry);
	return entry;
}
