// Workspace text-search engine — public entry point.
//
// Picks the best available backend (bundled ripgrep, else a pure-`vscode`-API
// fallback) and streams each matching file to `opts.onFile`. Both backends
// honour cancellation, so starting a new search abandons the previous one.

import * as vscode from 'vscode';

import type { SearchParams } from '../core/types';
import { EMPTY, type EngineOutcome, type RunOptions } from './engineCore';
import { locateRipgrep, runRipgrep } from './ripgrepEngine';
import { runJsSearch } from './jsEngine';

// Re-export the shared surface so callers and tests have a single import site.
export type { EngineFile, EngineMatch, EngineOutcome, RunOptions } from './engineCore';
export { splitGlobs } from './engineCore';
export { buildRipgrepArgs, locateRipgrep } from './ripgrepEngine';
export { buildLineRegExp, escapeRegExp, matchLine } from './jsEngine';

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
