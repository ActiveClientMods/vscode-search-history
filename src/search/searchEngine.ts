// Workspace text-search engine — public entry point.
//
// Picks the best available backend (bundled ripgrep, else a pure-`vscode`-API
// fallback) and streams each matching file to `opts.onFile`. Both backends
// honour cancellation, so starting a new search abandons the previous one.
//
// Both backends read from **disk**. Editors with unsaved changes would
// therefore be searched in their last-saved state, which makes results look
// stale exactly when you are iterating fastest (edit → search → "but I just
// changed that"). To avoid it, files with a dirty editor are withheld from the
// backend's output and re-scanned from the in-memory document instead — see
// {@link scanDirtyDocuments}.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as vscode from 'vscode';

import type { SearchParams } from '../core/types';
import {
	EMPTY,
	type EngineFile,
	type EngineMatch,
	type EngineOutcome,
	type RunOptions,
	defaultExcludeGlobs,
	previewSlice,
	relativePath,
	splitGlobs,
} from './engineCore';
import { isInSearchScope } from './globMatch';
import { buildLineRegExp, matchLine, runJsSearch } from './jsEngine';
import { locateRipgrep, runRipgrep } from './ripgrepEngine';

// Re-export the shared surface so callers and tests have a single import site.
export type { EngineFile, EngineMatch, EngineOutcome, RunOptions } from './engineCore';
export { splitGlobs } from './engineCore';
export { buildRipgrepArgs, locateRipgrep } from './ripgrepEngine';
export { buildLineRegExp, escapeRegExp, execLine, matchLine } from './jsEngine';

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

	// An include field may name concrete paths (absolute, or `./`-relative to the
	// workspace) rather than globs — VS Code treats those as *where* to search, not
	// as a filter. Split them out into search roots; the remaining globs stay in the
	// include field.
	const resolved = resolveIncludePaths(params.filesToInclude, folders);
	if (resolved.hadPathSpecs && resolved.roots.length === 0) {
		return EMPTY; // every named path was missing — nothing to search
	}
	const searchPaths = resolved.hadPathSpecs ? resolved.roots : folders.map((f) => f.uri.fsPath);
	const effectiveParams =
		resolved.includeField === params.filesToInclude
			? params
			: { ...params, filesToInclude: resolved.includeField };

	// Files whose editor has unsaved changes are handled separately, below.
	const dirty = dirtyDocuments(searchPaths);
	let fileCount = 0;
	let matchCount = 0;
	const emit = (file: EngineFile) => {
		if (dirty.has(file.uri.toString())) {
			return; // superseded by the in-memory scan
		}
		fileCount += 1;
		matchCount += file.matches.length;
		opts.onFile(file);
	};

	const rg = locateRipgrep();
	const outcome = rg
		? await runRipgrep(rg, effectiveParams, searchPaths, { ...opts, onFile: emit })
		: await runJsSearch(effectiveParams, { ...opts, onFile: emit });

	if (opts.token.isCancellationRequested || outcome.error) {
		return { ...outcome, fileCount, matchCount };
	}

	const overlay = scanDirtyDocuments([...dirty.values()], effectiveParams, {
		...opts,
		maxMatches: Math.max(0, opts.maxMatches - matchCount),
		onFile: (file) => {
			fileCount += 1;
			matchCount += file.matches.length;
			opts.onFile(file);
		},
	});

	return {
		...outcome,
		fileCount,
		matchCount,
		truncated: outcome.truncated || overlay.truncated,
	};
}

/** Open documents with unsaved changes that a search over `searchPaths` could reach, by URI. */
function dirtyDocuments(searchPaths: readonly string[]): Map<string, vscode.TextDocument> {
	const out = new Map<string, vscode.TextDocument>();
	for (const document of vscode.workspace.textDocuments) {
		if (
			document.isDirty &&
			document.uri.scheme === 'file' &&
			searchPaths.some((root) => isUnder(document.uri.fsPath, root))
		) {
			out.set(document.uri.toString(), document);
		}
	}
	return out;
}

/** True when `target` is `root` itself or lives somewhere beneath it. */
function isUnder(target: string, root: string): boolean {
	const rel = path.relative(root, target);
	return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Does a raw include entry name a concrete path (absolute or `./`-relative) rather than a glob? */
function isPathSpec(spec: string): boolean {
	return path.isAbsolute(spec) || spec === '.' || spec === '..' || /^\.\.?[/\\]/.test(spec);
}

/**
 * Separate the include field into concrete search roots and leftover globs.
 *
 * VS Code lets the "files to include" field hold real paths — an absolute path,
 * or one relative to the workspace (`./src`, `../sibling`) — and searches *inside*
 * them rather than treating them as name filters. Absolute paths may even point
 * outside the workspace. Resolved roots are filtered to those that exist so a
 * typo can't make ripgrep error out; a bare name like `src` stays a glob.
 */
function resolveIncludePaths(
	filesToInclude: string,
	folders: readonly vscode.WorkspaceFolder[],
): { roots: string[]; includeField: string; hadPathSpecs: boolean } {
	const roots: string[] = [];
	const globs: string[] = [];
	let hadPathSpecs = false;
	for (const spec of splitGlobs(filesToInclude)) {
		if (!isPathSpec(spec)) {
			globs.push(spec);
			continue;
		}
		hadPathSpecs = true;
		const candidates = path.isAbsolute(spec)
			? [path.normalize(spec)]
			: folders.map((f) => path.resolve(f.uri.fsPath, spec));
		for (const candidate of candidates) {
			if (fs.existsSync(candidate) && !roots.includes(candidate)) {
				roots.push(candidate);
			}
		}
	}
	return { roots, includeField: globs.join(', '), hadPathSpecs };
}

/**
 * Scan the given in-memory documents, honouring the search's include/exclude
 * globs (which the backend applied for us on the files it read from disk).
 */
function scanDirtyDocuments(
	documents: readonly vscode.TextDocument[],
	params: SearchParams,
	opts: RunOptions,
): { truncated: boolean } {
	if (documents.length === 0 || opts.maxMatches <= 0) {
		return { truncated: false };
	}
	const { regex } = buildLineRegExp(params);
	if (!regex) {
		return { truncated: false };
	}
	const includes = splitGlobs(params.filesToInclude);
	const excludes = [...splitGlobs(params.filesToExclude), ...defaultExcludeGlobs()];
	const multiRoot = (vscode.workspace.workspaceFolders?.length ?? 0) > 1;

	let remaining = opts.maxMatches;
	let truncated = false;
	for (const document of documents) {
		if (opts.token.isCancellationRequested || truncated) {
			break;
		}
		const relative = relativePath(document.uri, multiRoot);
		if (!isInSearchScope(relative, includes, excludes)) {
			continue;
		}
		const matches: EngineMatch[] = [];
		for (let i = 0; i < document.lineCount && !truncated; i++) {
			const text = document.lineAt(i).text;
			for (const found of matchLine(regex, text)) {
				const preview = previewSlice(text, found.column);
				matches.push({
					line: i + 1,
					column: found.column,
					endColumn: found.endColumn,
					preview: preview.text,
					previewStart: preview.start,
				});
				remaining -= 1;
				if (remaining <= 0) {
					truncated = true;
					break;
				}
			}
		}
		if (matches.length > 0) {
			opts.onFile({ uri: document.uri, relativePath: relative, matches });
		}
	}
	return { truncated };
}
