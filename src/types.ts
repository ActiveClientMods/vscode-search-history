// Shared domain types for the Search History Explorer extension.

/** The raw parameters that define a search, independent of history bookkeeping. */
export interface SearchParams {
	/** The search query text (may be a regular expression when {@link isRegex} is set). */
	query: string;
	isRegex: boolean;
	isCaseSensitive: boolean;
	matchWholeWord: boolean;
	/** Replacement text, matching VS Code's "replace" field (empty for a plain search). */
	replaceText: string;
	/** Glob(s) to include, matching VS Code's "files to include" field. */
	filesToInclude: string;
	/** Glob(s) to exclude, matching VS Code's "files to exclude" field. */
	filesToExclude: string;
}

/** A persisted search-history record. */
export interface SearchHistoryEntry extends SearchParams {
	/** Stable, unique identifier. */
	id: string;
	/** Stable id of the workspace the search was made in (empty string when none). */
	workspaceId: string;
	/** Human-readable workspace name for display. */
	workspaceName: string;
	/** Epoch millis when the entry was first created. */
	createdAt: number;
	/** Epoch millis when the search was last run. */
	lastUsedAt: number;
	/** How many times the search has been run. */
	useCount: number;
	favorite: boolean;
	tags: string[];
	/** Free-text note the user attached to this search (empty when none). */
	note: string;
	/** Id of the folder this entry is grouped under, if any. */
	folderId?: string;
}

export type Scope = 'global' | 'workspace';

/**
 * A user-created folder for grouping topic-related searches. A folder is either
 * `global` (visible across every workspace) or `workspace`-scoped (visible only
 * in the workspace it was created in).
 */
export interface SearchFolder {
	/** Stable, unique identifier. */
	id: string;
	name: string;
	scope: Scope;
	/** Owning workspace id for `workspace`-scoped folders; empty for `global`. */
	workspaceId: string;
	createdAt: number;
}

/** The current filter/scope state that drives what the tree renders. */
export interface FilterState {
	/** Free-text (or regex) filter applied to query, tags and workspace name. */
	text: string;
	/** Whether {@link text} is treated as a regular expression. */
	useRegex: boolean;
	favoritesOnly: boolean;
	/** Only entries carrying every one of these tags are shown (empty = no tag filter). */
	tags: string[];
	scope: Scope;
}

export const DEFAULT_FILTER_STATE: FilterState = {
	text: '',
	useRegex: false,
	favoritesOnly: false,
	tags: [],
	scope: 'global',
};
