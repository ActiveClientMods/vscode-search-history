// Search engine backed by the `ripgrep` binary that ships inside VS Code.
//
// Preferred over the JS fallback because it is fast, respects `.gitignore`, and
// streams results as newline-delimited JSON. We never bundle our own binary —
// we locate the one already inside the running VS Code install.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { SearchParams } from '../core/types';
import {
	type EngineFile,
	type EngineOutcome,
	type RunOptions,
	previewSlice,
	relativePath,
	splitGlobs,
} from './engineCore';

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
	if (params.isRegex) {
		// Ripgrep's default (Rust `regex`) engine rejects look-around and
		// backreferences outright. `--engine=auto` keeps that fast engine for
		// ordinary patterns and transparently falls back to PCRE2 for the ones
		// that need it — the same hybrid strategy VS Code's own search uses, so
		// a pattern that works in Find-in-Files works here too.
		args.push('--engine=auto');
	} else {
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
function rgText(field: RgField | undefined): string | undefined {
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

export function runRipgrep(
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
				for (const sm of obj.data.submatches ?? []) {
					const column = byteToChar(lineText, sm.start);
					const preview = previewSlice(lineText, column);
					current.matches.push({
						line: lineNo,
						column,
						endColumn: byteToChar(lineText, sm.end),
						preview: preview.text,
						previewStart: preview.start,
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
