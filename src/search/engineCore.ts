// Shared types, constants and helpers for the workspace text-search engines.
//
// VS Code exposes no supported API to run a text search and read the results
// back (`workspace.findTextInFiles` is still a proposed API). So we run the
// search ourselves via one of two engines — bundled ripgrep ({@link
// ./ripgrepEngine}) or a pure-`vscode`-API fallback ({@link ./jsEngine}) — both
// of which build on the shared pieces defined here.

import * as vscode from 'vscode';

/** A single match occurrence within a line (0-based character columns). */
export interface EngineMatch {
	line: number; // 1-based
	column: number; // 0-based, inclusive
	endColumn: number; // 0-based, exclusive
	preview: string; // the line text, possibly only a slice of it (see previewStart)
	/** Column {@link preview} starts at, so `column` stays a real document coordinate. */
	previewStart: number;
}

/** All matches within one file. */
export interface EngineFile {
	uri: vscode.Uri;
	relativePath: string;
	matches: EngineMatch[];
}

export interface EngineOutcome {
	fileCount: number;
	matchCount: number;
	truncated: boolean;
	engine: 'ripgrep' | 'js';
	error?: string;
	/** True when the query is an invalid regular expression (so it shouldn't be saved). */
	regexInvalid?: boolean;
}

export interface RunOptions {
	maxMatches: number;
	token: vscode.CancellationToken;
	onFile: (file: EngineFile) => void;
}

/** How much of a matched line is carried to the UI at most. */
export const PREVIEW_LIMIT = 1000;
/** Characters kept in front of the match when a line has to be cut down. */
export const PREVIEW_LEAD = 100;
export const MAX_FILES = 20000;

export const EMPTY: EngineOutcome = { fileCount: 0, matchCount: 0, truncated: false, engine: 'js' };

/** Split a comma-separated glob field into individual, trimmed patterns. */
export function splitGlobs(value: string): string[] {
	return value
		.split(',')
		.map((g) => g.trim())
		.filter((g) => g !== '');
}

/**
 * The slice of a matched line worth sending on, together with the column it
 * starts at.
 *
 * A very long line (a minified bundle, a data blob) must be cut down, but
 * cutting it from the left throws away exactly the match the user is looking
 * for — the reason a hit near the end of a long line used to show up as an
 * apparently empty result row. So the slice is taken *around* the match.
 */
export function previewSlice(line: string, matchStart: number): { text: string; start: number } {
	const stripped = line.replace(/\r?\n$/, '');
	if (stripped.length <= PREVIEW_LIMIT) {
		return { text: stripped, start: 0 };
	}
	const start = Math.max(0, Math.min(matchStart - PREVIEW_LEAD, stripped.length - PREVIEW_LIMIT));
	return { text: stripped.slice(start, start + PREVIEW_LIMIT), start };
}

export function relativePath(uri: vscode.Uri, multiRoot: boolean): string {
	return vscode.workspace.asRelativePath(uri, multiRoot);
}
