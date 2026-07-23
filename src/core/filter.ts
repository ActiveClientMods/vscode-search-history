// Pure, side-effect-free filtering & sorting logic.
//
// Kept free of any `vscode` imports so it can be unit-tested in isolation and
// reused regardless of the storage backend.

import type { FilterState, SearchHistoryEntry } from './types';

export interface FilterContext {
	/** Id of the workspace currently open, used when scope === 'workspace'. */
	currentWorkspaceId: string;
}

export interface FilterResult {
	entries: SearchHistoryEntry[];
	/** Set when {@link FilterState.useRegex} is on but the pattern failed to compile. */
	regexError?: string;
}

/**
 * Build a predicate that matches an entry's text fields against the filter.
 *
 * Returns the predicate plus an optional regex error. When the user asked for a
 * regex filter but the pattern is invalid, the predicate matches nothing so the
 * caller can surface the error rather than silently showing everything.
 */
function buildTextPredicate(state: FilterState): {
	predicate: (entry: SearchHistoryEntry) => boolean;
	regexError?: string;
} {
	const text = state.text.trim();
	if (text === '') {
		return { predicate: () => true };
	}

	const haystack = (entry: SearchHistoryEntry): string =>
		[entry.query, entry.note, entry.workspaceName, entry.filesToInclude, entry.filesToExclude, ...entry.tags]
			.filter(Boolean)
			.join('\n');

	if (state.useRegex) {
		let re: RegExp;
		try {
			re = new RegExp(text, 'i');
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { predicate: () => false, regexError: message };
		}
		// Reset lastIndex safety: no global flag is used, so `.test` is stateless.
		return { predicate: (entry) => re.test(haystack(entry)) };
	}

	const needle = text.toLowerCase();
	return { predicate: (entry) => haystack(entry).toLowerCase().includes(needle) };
}

/** Favorites first, then most-recently-used first, then newest first. */
export function sortEntries(entries: SearchHistoryEntry[]): SearchHistoryEntry[] {
	return entries.toSorted((a, b) => {
		if (a.favorite !== b.favorite) {
			return a.favorite ? -1 : 1;
		}
		if (a.lastUsedAt !== b.lastUsedAt) {
			return b.lastUsedAt - a.lastUsedAt;
		}
		return b.createdAt - a.createdAt;
	});
}

/**
 * Apply the full filter state (scope, favorites, tags, text/regex) to a list of
 * entries and return the sorted, filtered result.
 */
export function filterEntries(
	entries: SearchHistoryEntry[],
	state: FilterState,
	context: FilterContext,
): FilterResult {
	const { predicate, regexError } = buildTextPredicate(state);
	const requiredTags = state.tags.map((t) => t.toLowerCase());

	const matched = entries.filter((entry) => {
		if (state.scope === 'workspace' && entry.workspaceId !== context.currentWorkspaceId) {
			return false;
		}
		if (state.favoritesOnly && !entry.favorite) {
			return false;
		}
		if (requiredTags.length > 0) {
			const entryTags = entry.tags.map((t) => t.toLowerCase());
			if (!requiredTags.every((t) => entryTags.includes(t))) {
				return false;
			}
		}
		return predicate(entry);
	});

	return { entries: sortEntries(matched), regexError };
}
