// Replace across files, for the in-view results list.
//
// The search engines (ripgrep / the JS fallback) only report *where* matches
// are. Replacing needs more: the capture groups behind each match, so a regex
// replacement like `$1_$2` can be expanded. It also needs to work off the text
// as it is *right now*, not off a result set that may be seconds old.
//
// So replacing re-scans each target document with the same compiled RegExp the
// JS engine uses and rewrites what it finds there. Cached result positions are
// only ever used to *select* which match to act on, never as the range to edit.
//
// Edits go through a single `WorkspaceEdit`, matching VS Code's own Search
// view: files are left dirty (not saved) so one Undo puts everything back.

import * as vscode from 'vscode';

import type { SearchParams } from '../core/types';
import { buildLineRegExp, execLine } from './jsEngine';

/** One pending rewrite within a document. */
export interface PlannedReplacement {
	/** 1-based line number, matching {@link EngineMatch}. */
	line: number;
	/** 0-based, inclusive. */
	column: number;
	/** 0-based, exclusive. */
	endColumn: number;
	/** The text currently at `[column, endColumn)`. */
	text: string;
	/** What it will be replaced with. */
	replacement: string;
}

/** Identifies a single occurrence, as reported by a search result row. */
export interface MatchLocation {
	line: number;
	column: number;
}

export interface ReplaceSummary {
	files: number;
	matches: number;
	error?: string;
}

/**
 * Expand a replacement template against one match.
 *
 * In literal (non-regex) mode the template is inserted verbatim — `$1` is a
 * dollar sign followed by a one, exactly as in VS Code. In regex mode `$0`/`$&`
 * (whole match), `$1`…`$99`, `$<name>` and `$$` are substituted, and `\n`,
 * `\t`, `\r` and `\\` are unescaped.
 */
export function expandReplacement(match: RegExpExecArray, template: string, isRegex: boolean): string {
	if (!isRegex) {
		return template;
	}
	// Unescape first, then substitute: a captured group whose *text* contains a
	// backslash sequence must survive untouched.
	const unescaped = template.replace(/\\(.)/g, (whole, char: string) => {
		switch (char) {
			case 'n':
				return '\n';
			case 't':
				return '\t';
			case 'r':
				return '\r';
			case '\\':
				return '\\';
			default:
				return whole;
		}
	});
	return unescaped.replace(
		/\$(\$|&|<([^>]*)>|\d{1,2})/g,
		(whole, token: string, name: string | undefined) => {
			if (token === '$') {
				return '$';
			}
			if (token === '&') {
				return match[0];
			}
			if (name !== undefined) {
				return match.groups?.[name] ?? '';
			}
			const index = Number(token);
			// A group number the pattern doesn't have is left as typed, like JS does.
			return index < match.length ? (match[index] ?? '') : whole;
		},
	);
}

/**
 * Work out every rewrite the given search implies for one document, expressed
 * as its lines. Returns an error instead of throwing for an invalid regex.
 */
export function planReplacements(
	lines: readonly string[],
	params: SearchParams,
): { plan: PlannedReplacement[]; error?: string } {
	const { regex, error } = buildLineRegExp(params);
	if (!regex) {
		return { plan: [], error: error ?? 'Invalid regular expression' };
	}
	const plan: PlannedReplacement[] = [];
	for (const [index, line] of lines.entries()) {
		for (const match of execLine(regex, line)) {
			plan.push({
				line: index + 1,
				column: match.index,
				endColumn: match.index + match[0].length,
				text: match[0],
				replacement: expandReplacement(match, params.replaceText, params.isRegex),
			});
		}
	}
	return { plan };
}

/** Restrict a plan to the occurrences the user actually asked to replace. */
export function selectReplacements(
	plan: readonly PlannedReplacement[],
	locations: readonly MatchLocation[] | undefined,
): PlannedReplacement[] {
	if (!locations) {
		return [...plan];
	}
	const wanted = new Set(locations.map((l) => `${l.line}:${l.column}`));
	return plan.filter((p) => wanted.has(`${p.line}:${p.column}`));
}

/** Read a document's lines exactly as VS Code models them. */
function documentLines(document: vscode.TextDocument): string[] {
	const lines: string[] = [];
	for (let i = 0; i < document.lineCount; i++) {
		lines.push(document.lineAt(i).text);
	}
	return lines;
}

/**
 * Replace in one or more files. Pass `locations` (keyed by file URI string) to
 * limit the rewrite to specific occurrences; omit it to replace everything the
 * search matches in those files.
 */
export async function replaceInFiles(
	uris: readonly vscode.Uri[],
	params: SearchParams,
	locations?: ReadonlyMap<string, MatchLocation[]>,
): Promise<ReplaceSummary> {
	const edit = new vscode.WorkspaceEdit();
	let files = 0;
	let matches = 0;

	for (const uri of uris) {
		let document: vscode.TextDocument;
		try {
			document = await vscode.workspace.openTextDocument(uri);
		} catch {
			continue; // deleted or unreadable since the search ran
		}
		const { plan, error } = planReplacements(documentLines(document), params);
		if (error) {
			return { files: 0, matches: 0, error };
		}
		const selected = selectReplacements(plan, locations?.get(uri.toString()));
		if (selected.length === 0) {
			continue;
		}
		for (const item of selected) {
			edit.replace(
				uri,
				new vscode.Range(item.line - 1, item.column, item.line - 1, item.endColumn),
				item.replacement,
			);
		}
		files += 1;
		matches += selected.length;
	}

	if (matches === 0) {
		return { files: 0, matches: 0 };
	}
	const applied = await vscode.workspace.applyEdit(edit);
	if (!applied) {
		return { files: 0, matches: 0, error: 'The replacement could not be applied.' };
	}
	return { files, matches };
}

/** Human-readable "3 occurrences across 2 files" phrasing shared by prompts and status. */
export function describeReplacement(files: number, matches: number): string {
	const m = `${matches} ${matches === 1 ? 'occurrence' : 'occurrences'}`;
	const f = `${files} ${files === 1 ? 'file' : 'files'}`;
	return files === 1 ? m : `${m} across ${f}`;
}
