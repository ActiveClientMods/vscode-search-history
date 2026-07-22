// Storage layer.
//
// Architectural decision — Option A (native `Memento`/globalState).
// See README ("Architecture") for the full evaluation. In short: regex
// filtering cannot be pushed into SQLite (no built-in REGEXP), an embedded
// database pulls in native modules that complicate cross-platform `.vsix`
// packaging, and a bounded, in-memory history filters in well under a
// millisecond. `Memento` is zero-dependency, cross-platform and syncable.

import type { Memento } from 'vscode';
import type { Scope, SearchFolder, SearchHistoryEntry, SearchParams } from './types';

export const STORAGE_KEY = 'searchHistory.entries.v1';
export const FOLDERS_KEY = 'searchHistory.folders.v1';

export interface HistoryStoreOptions {
	maxEntries: number;
	deduplicate: boolean;
}

/** Minimal event surface so consumers can subscribe without importing `vscode`. */
export type ChangeListener = () => void;

let idCounter = 0;
function makeId(): string {
	idCounter += 1;
	return `${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Two search parameter sets are considered "the same search" for dedupe. */
function sameSearch(a: SearchParams, b: SearchParams): boolean {
	return (
		a.query === b.query &&
		a.isRegex === b.isRegex &&
		a.isCaseSensitive === b.isCaseSensitive &&
		a.matchWholeWord === b.matchWholeWord &&
		a.filesToInclude === b.filesToInclude &&
		a.filesToExclude === b.filesToExclude
	);
}

export interface RecordInput extends SearchParams {
	workspaceId: string;
	workspaceName: string;
}

/**
 * CRUD-style store over a VS Code `Memento`. All mutations persist immediately
 * and notify listeners. The store is intentionally storage-agnostic: any object
 * implementing the `Memento` contract works, which keeps it unit-testable with a
 * plain in-memory fake.
 */
export class HistoryStore {
	private readonly listeners = new Set<ChangeListener>();

	constructor(
		private readonly memento: Memento,
		private options: HistoryStoreOptions,
	) {}

	onDidChange(listener: ChangeListener): { dispose(): void } {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	updateOptions(options: HistoryStoreOptions): void {
		this.options = options;
	}

	// --- Entries -------------------------------------------------------------

	getAll(): SearchHistoryEntry[] {
		return this.memento.get<SearchHistoryEntry[]>(STORAGE_KEY, []);
	}

	getById(id: string): SearchHistoryEntry | undefined {
		return this.getAll().find((e) => e.id === id);
	}

	/**
	 * Record a search that was just run. With dedupe enabled, an identical search
	 * in the same workspace bumps the existing entry's usage stats instead of
	 * creating a duplicate. Returns the entry that now represents the search.
	 */
	async record(input: RecordInput): Promise<SearchHistoryEntry> {
		const entries = this.getAll();
		const now = Date.now();

		if (this.options.deduplicate) {
			const existing = entries.find(
				(e) => e.workspaceId === input.workspaceId && sameSearch(e, input),
			);
			if (existing) {
				existing.lastUsedAt = now;
				existing.useCount += 1;
				// A repeated search may originate from a renamed workspace folder.
				existing.workspaceName = input.workspaceName;
				await this.saveEntries(entries);
				return existing;
			}
		}

		const entry: SearchHistoryEntry = {
			id: makeId(),
			query: input.query,
			isRegex: input.isRegex,
			isCaseSensitive: input.isCaseSensitive,
			matchWholeWord: input.matchWholeWord,
			filesToInclude: input.filesToInclude,
			filesToExclude: input.filesToExclude,
			workspaceId: input.workspaceId,
			workspaceName: input.workspaceName,
			createdAt: now,
			lastUsedAt: now,
			useCount: 1,
			favorite: false,
			tags: [],
		};
		entries.push(entry);
		await this.saveEntries(this.prune(entries));
		return entry;
	}

	async touch(id: string): Promise<void> {
		await this.mutate(id, (e) => {
			e.lastUsedAt = Date.now();
			e.useCount += 1;
		});
	}

	async setFavorite(id: string, favorite: boolean): Promise<void> {
		await this.mutate(id, (e) => {
			e.favorite = favorite;
		});
	}

	async toggleFavorite(id: string): Promise<void> {
		await this.mutate(id, (e) => {
			e.favorite = !e.favorite;
		});
	}

	async setTags(id: string, tags: string[]): Promise<void> {
		const normalized = normalizeTags(tags);
		await this.mutate(id, (e) => {
			e.tags = normalized;
		});
	}

	/** Move an entry into a folder, or out of any folder when `folderId` is undefined. */
	async moveEntryToFolder(id: string, folderId: string | undefined): Promise<void> {
		await this.mutate(id, (e) => {
			if (folderId === undefined) {
				delete e.folderId;
			} else {
				e.folderId = folderId;
			}
		});
	}

	async remove(id: string): Promise<void> {
		const entries = this.getAll().filter((e) => e.id !== id);
		await this.saveEntries(entries);
	}

	/** Collect the distinct tags currently in use, sorted alphabetically. */
	allTags(): string[] {
		const set = new Set<string>();
		for (const entry of this.getAll()) {
			for (const tag of entry.tags) {
				set.add(tag);
			}
		}
		return [...set].toSorted((a, b) => a.localeCompare(b));
	}

	// --- Folders -------------------------------------------------------------

	getFolders(): SearchFolder[] {
		return this.memento.get<SearchFolder[]>(FOLDERS_KEY, []);
	}

	getFolderById(id: string): SearchFolder | undefined {
		return this.getFolders().find((f) => f.id === id);
	}

	async createFolder(name: string, scope: Scope, workspaceId: string): Promise<SearchFolder> {
		const folder: SearchFolder = {
			id: makeId(),
			name: name.trim(),
			scope,
			workspaceId: scope === 'workspace' ? workspaceId : '',
			createdAt: Date.now(),
		};
		const folders = this.getFolders();
		folders.push(folder);
		await this.saveFolders(folders);
		return folder;
	}

	async renameFolder(id: string, name: string): Promise<void> {
		const trimmed = name.trim();
		if (trimmed === '') {
			return;
		}
		const folders = this.getFolders();
		const folder = folders.find((f) => f.id === id);
		if (!folder) {
			return;
		}
		folder.name = trimmed;
		await this.saveFolders(folders);
	}

	/** Delete a folder; entries inside it are kept and become ungrouped. */
	async deleteFolder(id: string): Promise<void> {
		const folders = this.getFolders().filter((f) => f.id !== id);
		await this.saveFolders(folders);

		const entries = this.getAll();
		let changed = false;
		for (const entry of entries) {
			if (entry.folderId === id) {
				delete entry.folderId;
				changed = true;
			}
		}
		if (changed) {
			await this.saveEntries(entries);
		}
	}

	// --- Bulk ----------------------------------------------------------------

	/**
	 * Clear history. With no scope, everything (entries and folders) is removed.
	 * With a `workspaceId`, only that workspace's entries and workspace-scoped
	 * folders are removed.
	 */
	async clear(workspaceId?: string): Promise<void> {
		if (workspaceId === undefined) {
			await this.saveEntries([]);
			await this.saveFolders([]);
			return;
		}
		await this.saveEntries(this.getAll().filter((e) => e.workspaceId !== workspaceId));
		await this.saveFolders(this.getFolders().filter((f) => f.workspaceId !== workspaceId));
	}

	// --- Internals -----------------------------------------------------------

	private async mutate(id: string, fn: (entry: SearchHistoryEntry) => void): Promise<void> {
		const entries = this.getAll();
		const entry = entries.find((e) => e.id === id);
		if (!entry) {
			return;
		}
		fn(entry);
		await this.saveEntries(entries);
	}

	/**
	 * Enforce the `maxEntries` cap. Favorites are preserved; the oldest
	 * non-favorite entries are dropped first, and only if that is not enough are
	 * the oldest favorites dropped.
	 */
	private prune(entries: SearchHistoryEntry[]): SearchHistoryEntry[] {
		const max = this.options.maxEntries;
		if (entries.length <= max) {
			return entries;
		}
		const byAgeAsc = entries.toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
		const toDrop = entries.length - max;
		const doomed = new Set<string>();

		for (const entry of byAgeAsc) {
			if (doomed.size >= toDrop) {
				break;
			}
			if (!entry.favorite) {
				doomed.add(entry.id);
			}
		}
		// Still over the cap because there are too many favorites: drop oldest ones.
		for (const entry of byAgeAsc) {
			if (doomed.size >= toDrop) {
				break;
			}
			doomed.add(entry.id);
		}
		return entries.filter((e) => !doomed.has(e.id));
	}

	private async saveEntries(entries: SearchHistoryEntry[]): Promise<void> {
		await this.memento.update(STORAGE_KEY, entries);
		this.notify();
	}

	private async saveFolders(folders: SearchFolder[]): Promise<void> {
		await this.memento.update(FOLDERS_KEY, folders);
		this.notify();
	}

	private notify(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}
}

/** Trim, drop empties, and de-duplicate case-insensitively while keeping order. */
export function normalizeTags(tags: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of tags) {
		const tag = raw.trim();
		if (tag === '') {
			continue;
		}
		const key = tag.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(tag);
	}
	return result;
}
