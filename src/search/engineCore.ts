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
	preview: string; // the (truncated) line text
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

export const PREVIEW_LIMIT = 400;
export const MAX_FILES = 20000;

export const EMPTY: EngineOutcome = { fileCount: 0, matchCount: 0, truncated: false, engine: 'js' };

/** Split a comma-separated glob field into individual, trimmed patterns. */
export function splitGlobs(value: string): string[] {
	return value
		.split(',')
		.map((g) => g.trim())
		.filter((g) => g !== '');
}

export function truncatePreview(line: string): string {
	const stripped = line.replace(/\r?\n$/, '');
	return stripped.length > PREVIEW_LIMIT ? stripped.slice(0, PREVIEW_LIMIT) + '…' : stripped;
}

export function relativePath(uri: vscode.Uri, multiRoot: boolean): string {
	return vscode.workspace.asRelativePath(uri, multiRoot);
}
