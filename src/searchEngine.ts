// Workspace text-search engine for the in-view results list.
//
// VS Code exposes no supported API to run a text search and read the results
// back (`workspace.findTextInFiles` is still a proposed API). So we run the
// search ourselves: prefer the `ripgrep` binary that ships inside VS Code, and
// fall back to a pure-`vscode`-API scan (`findFiles` + `fs.readFile` + regex)
// when it cannot be located. Both stream results file-by-file and honour
// cancellation, so starting a new search abandons the previous one.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { SearchParams } from './types';

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

const PREVIEW_LIMIT = 400;
const MAX_FILES = 20000;

const EMPTY: EngineOutcome = { fileCount: 0, matchCount: 0, truncated: false, engine: 'js' };

/**
 * Run a workspace text search, streaming each matching file to `opts.onFile`.
 * Resolves once the search finishes, is cancelled, or errors.
 */
export async function runSearch(params: SearchParams, opts: RunOptions): Promise<EngineOutcome> {
	if (params.query.trim() === '') {
		return EMPTY;
	}
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return { ...EMPTY, error: 'Open a folder to search in.' };
	}

	const rg = locateRipgrep();
	if (rg) {
		return runRipgrep(rg, params, folders.map((f) => f.uri.fsPath), opts);
	}
	return runJsSearch(params, opts);
}

// --- Shared helpers ----------------------------------------------------------

/** Split a comma-separated glob field into individual, trimmed patterns. */
export function splitGlobs(value: string): string[] {
	return value
		.split(',')
		.map((g) => g.trim())
		.filter((g) => g !== '');
}

function truncatePreview(line: string): string {
	const stripped = line.replace(/\r?\n$/, '');
	return stripped.length > PREVIEW_LIMIT ? stripped.slice(0, PREVIEW_LIMIT) + '…' : stripped;
}

function relativePath(uri: vscode.Uri, multiRoot: boolean): string {
	return vscode.workspace.asRelativePath(uri, multiRoot);
}

// --- Ripgrep -----------------------------------------------------------------

/** Best-effort location of the ripgrep binary bundled inside VS Code itself. */
export function locateRipgrep(existsSync: (p: string) => boolean = fs.existsSync): string | undefined {
	const appRoot = vscode.env.appRoot;
	if (!appRoot) {
		return undefined;
	}
	const exe = process.platform === 'win32' ? 'rg.exe' : 'rg';
	const platformDir = `${process.platform}-${process.arch}`;
	const bases = [
		['node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin'],
		['node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin'],
		['node_modules.asar.unpacked', 'vscode-ripgrep', 'bin'],
		['node_modules', '@vscode', 'ripgrep-universal', 'bin'],
		['node_modules', '@vscode', 'ripgrep', 'bin'],
		['node_modules', 'vscode-ripgrep', 'bin'],
	];
	for (const base of bases) {
		for (const candidate of [
			path.join(appRoot, ...base, platformDir, exe),
			path.join(appRoot, ...base, exe),
		]) {
			if (existsSync(candidate)) {
				return candidate;
			}
		}
	}
	return undefined;
}

/** Build the ripgrep argument vector for the given search. */
export function buildRipgrepArgs(params: SearchParams, searchPaths: string[]): string[] {
	const args = ['--json'];
	args.push(params.isCaseSensitive ? '--case-sensitive' : '--ignore-case');
	if (params.matchWholeWord) {
		args.push('--word-regexp');
	}
	if (!params.isRegex) {
		args.push('--fixed-strings');
	}
	for (const glob of splitGlobs(params.filesToInclude)) {
		args.push('--glob', glob);
	}
	for (const glob of splitGlobs(params.filesToExclude)) {
		args.push('--glob', `!${glob}`);
	}
	// `--` ends option parsing so queries beginning with `-` are treated as the
	// pattern; the remaining positionals are the roots to search.
	args.push('--', params.query, ...searchPaths);
	return args;
}

/** Decode a ripgrep JSON "data" text/bytes field (bytes appears for invalid UTF-8). */
function rgText(field: { text?: string; bytes?: string } | undefined): string | undefined {
	if (!field) {
		return undefined;
	}
	if (typeof field.text === 'string') {
		return field.text;
	}
	if (typeof field.bytes === 'string') {
		return Buffer.from(field.bytes, 'base64').toString('utf8');
	}
	return undefined;
}

/** Convert a byte offset within a UTF-8 line to a character column. */
function byteToChar(line: string, byteOffset: number): number {
	return Buffer.from(line, 'utf8').subarray(0, byteOffset).toString('utf8').length;
}

function runRipgrep(
	rgPath: string,
	params: SearchParams,
	searchPaths: string[],
	opts: RunOptions,
): Promise<EngineOutcome> {
	const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
	return new Promise((resolve) => {
		const child = spawn(rgPath, buildRipgrepArgs(params, searchPaths));
		let matchCount = 0;
		let fileCount = 0;
		let truncated = false;
		let killed = false;
		let stderr = '';
		let buffer = '';
		let current: EngineFile | undefined;

		const stop = () => {
			killed = true;
			child.kill();
		};
		const cancel = opts.token.onCancellationRequested(stop);

		const handleLine = (raw: string) => {
			if (raw.trim() === '') {
				return;
			}
			let obj: RgMessage;
			try {
				obj = JSON.parse(raw) as RgMessage;
			} catch {
				return;
			}
			if (obj.type === 'begin') {
				const p = rgText(obj.data.path);
				if (p) {
					const uri = vscode.Uri.file(p);
					current = { uri, relativePath: relativePath(uri, multiRoot), matches: [] };
				}
			} else if (obj.type === 'match' && current) {
				const lineNo = obj.data.line_number ?? 0;
				const lineText = rgText(obj.data.lines) ?? '';
				const preview = truncatePreview(lineText);
				for (const sm of obj.data.submatches ?? []) {
					current.matches.push({
						line: lineNo,
						column: byteToChar(lineText, sm.start),
						endColumn: byteToChar(lineText, sm.end),
						preview,
					});
					matchCount += 1;
					if (matchCount >= opts.maxMatches) {
						truncated = true;
						break;
					}
				}
				if (truncated) {
					stop();
				}
			} else if (obj.type === 'end' && current) {
				if (current.matches.length > 0) {
					fileCount += 1;
					opts.onFile(current);
				}
				current = undefined;
			}
		};

		child.stdout.on('data', (chunk: Buffer) => {
			buffer += chunk.toString('utf8');
			let nl = buffer.indexOf('\n');
			while (nl !== -1) {
				handleLine(buffer.slice(0, nl));
				buffer = buffer.slice(nl + 1);
				nl = buffer.indexOf('\n');
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf8');
		});
		child.on('error', (err) => {
			cancel.dispose();
			resolve({ fileCount, matchCount, truncated, engine: 'ripgrep', error: `ripgrep failed: ${err.message}` });
		});
		child.on('close', (code) => {
			cancel.dispose();
			if (buffer.trim() !== '') {
				handleLine(buffer);
			}
			// rg exit codes: 0 = matches, 1 = no matches, 2 = error.
			const rawError = !killed && code === 2 && stderr.trim() !== ''
				? stderr.trim().split('\n')[0]
				: undefined;
			// Surface a clean, colon-free message for the common invalid-regex case
			// rather than ripgrep's raw "rg: regex parse error:" line.
			const regexInvalid = rawError !== undefined && /regex parse error/i.test(rawError);
			const error = regexInvalid ? 'Invalid regular expression' : rawError;
			resolve({ fileCount, matchCount, truncated, engine: 'ripgrep', error, regexInvalid });
		});
	});
}

interface RgField {
	text?: string;
	bytes?: string;
}
interface RgSubmatch {
	start: number;
	end: number;
}
type RgMessage =
	| { type: 'begin'; data: { path: RgField } }
	| { type: 'match'; data: { path: RgField; line_number?: number; lines: RgField; submatches?: RgSubmatch[] } }
	| { type: 'end'; data: { path: RgField } }
	| { type: 'summary'; data: unknown };

// --- Pure-API JS fallback ----------------------------------------------------

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

export function escapeRegExp(text: string): string {
	return text.replace(REGEX_SPECIAL, '\\$&');
}

/** Compile the query + flags into a global RegExp, or report why it failed. */
export function buildLineRegExp(params: SearchParams): { regex?: RegExp; error?: string } {
	let source = params.isRegex ? params.query : escapeRegExp(params.query);
	if (params.matchWholeWord) {
		source = `\\b(?:${source})\\b`;
	}
	const flags = params.isCaseSensitive ? 'g' : 'gi';
	try {
		return { regex: new RegExp(source, flags) };
	} catch (err) {
		return { error: err instanceof Error ? err.message : String(err) };
	}
}

/** All non-empty matches of `regex` within a single line (0-based columns). */
export function matchLine(regex: RegExp, line: string): { column: number; endColumn: number }[] {
	const out: { column: number; endColumn: number }[] = [];
	regex.lastIndex = 0;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(line)) !== null) {
		if (m[0] === '') {
			regex.lastIndex += 1;
			continue;
		}
		out.push({ column: m.index, endColumn: m.index + m[0].length });
	}
	return out;
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

/** Default file/search excludes so the JS scan skips node_modules, .git, etc. */
function defaultExcludeGlobs(): string[] {
	const cfg = vscode.workspace.getConfiguration();
	const out = new Set<string>();
	for (const key of ['files.exclude', 'search.exclude']) {
		const obj = cfg.get<Record<string, boolean>>(key) ?? {};
		for (const [glob, on] of Object.entries(obj)) {
			if (on) {
				out.add(glob);
			}
		}
	}
	return [...out];
}

async function runJsSearch(params: SearchParams, opts: RunOptions): Promise<EngineOutcome> {
	const { regex } = buildLineRegExp(params);
	if (!regex) {
		return { ...EMPTY, error: 'Invalid regular expression', regexInvalid: true };
	}

	const includes = splitGlobs(params.filesToInclude);
	const includeGlob = includes.length === 0 ? '**/*' : `{${includes.join(',')}}`;
	const excludes = [...splitGlobs(params.filesToExclude), ...defaultExcludeGlobs()];
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
				matches.push({ line: i + 1, column: found.column, endColumn: found.endColumn, preview: truncatePreview(lines[i]) });
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
