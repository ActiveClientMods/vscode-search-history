// Pure-`vscode`-API search engine used when the bundled ripgrep binary cannot be
// located. Slower than ripgrep, but fully cross-platform and dependency-free:
// it lists candidate files (`findFiles`), reads each one and scans it with a
// compiled RegExp, honouring include/exclude globs and `files.exclude` /
// `search.exclude`.

import * as vscode from 'vscode';

import type { SearchParams } from '../core/types';
import {
	EMPTY,
	type EngineMatch,
	type EngineOutcome,
	MAX_FILES,
	type RunOptions,
	defaultExcludeGlobs,
	previewSlice,
	relativePath,
	splitGlobs,
} from './engineCore';
import { normalizeSearchGlob } from './globMatch';

export { defaultExcludeGlobs } from './engineCore';

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(text: string): string {
	return text.replace(REGEX_SPECIAL, '\\$&');
}

/**
 * Compile the query + flags into a global RegExp, or report why it failed.
 *
 * This one RegExp has to agree with ripgrep, because the results list normally
 * comes from ripgrep while every *replacement* is computed here — a match the
 * two engines disagree about is one that cannot be replaced, or (worse) one
 * whose replacement lands somewhere the user was never shown.
 *
 * Whole-word matching is where they used to part ways. Wrapping the pattern in
 * `\b…\b` only means "surrounded by word boundaries" when the pattern itself
 * starts and ends with a word character: `\b(?:-foo)\b` demands a word
 * character *before* the hyphen, so it matched `x-foo` and skipped ` -foo` —
 * exactly the opposite of ripgrep's `--word-regexp`, which wraps the pattern as
 * `(?:^|\W)(…)(?:$|\W)`. The zero-width equivalent of that is a pair of
 * look-arounds, which is what we build here.
 *
 * Ripgrep's notion of a word character is Unicode-aware, JavaScript's `\w` is
 * not — so `str` as a whole word would match inside `strüber` here but not
 * there. The look-arounds therefore use `\p{L}\p{N}_`, which needs the `u`
 * flag; patterns that flag rejects (a stray `\-`, a literal `{,3}`) fall back
 * to plain `\w`.
 */
export function buildLineRegExp(params: SearchParams): { regex?: RegExp; error?: string } {
	const source = params.isRegex ? params.query : escapeRegExp(params.query);
	const flags = params.isCaseSensitive ? 'g' : 'gi';
	if (params.matchWholeWord) {
		try {
			return { regex: new RegExp(`(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`, `${flags}u`) };
		} catch {
			// Not a valid pattern under `u`; retry below and report any error there.
		}
	}
	const wrapped = params.matchWholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source;
	try {
		return { regex: new RegExp(wrapped, flags) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/**
 * All non-empty matches of `regex` within a single line, as raw exec results so
 * callers that need the capture groups (the replace engine) can have them.
 */
export function execLine(regex: RegExp, line: string): RegExpExecArray[] {
	const out: RegExpExecArray[] = [];
	regex.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(line)) !== null) {
		if (m[0] === '') {
			regex.lastIndex += 1;
			continue;
		}
		out.push(m);
	}
	return out;
}

/** All non-empty matches of `regex` within a single line (0-based columns). */
export function matchLine(regex: RegExp, line: string): { column: number; endColumn: number }[] {
	return execLine(regex, line).map((m) => ({ column: m.index, endColumn: m.index + m[0].length }));
}

function isBinary(bytes: Uint8Array): boolean {
	const cap = Math.min(bytes.length, 8000);
	for (let i = 0; i < cap; i++) {
		if (bytes[i] === 0) {
			return true;
		}
	}
	return false;
}

export async function runJsSearch(params: SearchParams, opts: RunOptions): Promise<EngineOutcome> {
	const { regex } = buildLineRegExp(params);
	if (!regex) {
		return { ...EMPTY, error: 'Invalid regular expression', regexInvalid: true };
	}

	// Expand each user pattern into VS Code's glob semantics (a bare `src` also
	// means `src/**`, a slashless name matches anywhere) so `findFiles` scopes
	// the same way the search bar's include/exclude fields do in the native view.
	const includes = splitGlobs(params.filesToInclude).flatMap(normalizeSearchGlob);
	const includeGlob = includes.length === 0 ? '**/*' : `{${includes.join(',')}}`;
	const excludes = [...splitGlobs(params.filesToExclude), ...defaultExcludeGlobs()].flatMap(
		normalizeSearchGlob,
	);
	const excludeGlob = excludes.length === 0 ? undefined : `{${excludes.join(',')}}`;

	const uris = await vscode.workspace.findFiles(includeGlob, excludeGlob, MAX_FILES, opts.token);
	const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

	let matchCount = 0;
	let fileCount = 0;
	let truncated = false;

	for (const uri of uris) {
		if (opts.token.isCancellationRequested) {
			break;
		}
		let bytes: Uint8Array;
		try {
			bytes = await vscode.workspace.fs.readFile(uri);
		} catch {
			continue;
		}
		if (isBinary(bytes)) {
			continue;
		}
		const lines = Buffer.from(bytes).toString('utf8').split(/\r\n|\r|\n/);
		const matches: EngineMatch[] = [];
		for (let i = 0; i < lines.length && !truncated; i++) {
			for (const found of matchLine(regex, lines[i])) {
				const preview = previewSlice(lines[i], found.column);
				matches.push({
					line: i + 1,
					column: found.column,
					endColumn: found.endColumn,
					preview: preview.text,
					previewStart: preview.start,
				});
				matchCount += 1;
				if (matchCount >= opts.maxMatches) {
					truncated = true;
					break;
				}
			}
		}
		if (matches.length > 0) {
			fileCount += 1;
			opts.onFile({ uri, relativePath: relativePath(uri, multiRoot), matches });
		}
		if (truncated) {
			break;
		}
	}
	return { fileCount, matchCount, truncated, engine: 'js' };
}
