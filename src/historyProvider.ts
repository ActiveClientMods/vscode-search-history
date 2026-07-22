import * as vscode from 'vscode';

import { filterEntries } from './filter';
import type { HistoryStore } from './storage';
import {
	DEFAULT_FILTER_STATE,
	type FilterState,
	type SearchFolder,
	type SearchHistoryEntry,
	type Scope,
} from './types';
import { currentWorkspace, hasWorkspace } from './workspace';

const FILTER_STATE_KEY = 'searchHistory.filterState.v1';
const DND_MIME = 'application/vnd.code.tree.searchhistoryview';

/** Tree item wrapping a single history entry. */
export class SearchHistoryItem extends vscode.TreeItem {
	constructor(public readonly entry: SearchHistoryEntry) {
		super(entry.query, vscode.TreeItemCollapsibleState.None);

		this.id = entry.id;
		this.contextValue = entry.favorite ? 'searchEntry.favorite' : 'searchEntry';
		this.iconPath = entry.favorite
			? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.yellow'))
			: new vscode.ThemeIcon('search');
		this.description = describeEntry(entry);
		this.tooltip = buildTooltip(entry);
		this.command = {
			command: 'searchHistory.runEntry',
			title: 'Run Search',
			arguments: [this],
		};
	}
}

/** Tree item for a folder grouping entries. */
export class FolderTreeItem extends vscode.TreeItem {
	constructor(
		public readonly folder: SearchFolder,
		count: number,
	) {
		super(folder.name, vscode.TreeItemCollapsibleState.Expanded);

		this.id = `folder:${folder.id}`;
		this.contextValue = 'searchFolder';
		this.iconPath = new vscode.ThemeIcon('folder');
		this.description = folder.scope === 'workspace' ? `${count} · workspace` : `${count}`;
		this.tooltip = new vscode.MarkdownString(
			`**${folder.name}**\n\n${count} ${count === 1 ? 'search' : 'searches'} · ${
				folder.scope === 'workspace' ? 'workspace folder' : 'global folder'
			}`,
		);
	}
}

type TreeElement = FolderTreeItem | SearchHistoryItem;

export class HistoryTreeProvider
	implements vscode.TreeDataProvider<TreeElement>, vscode.TreeDragAndDropController<TreeElement>
{
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChangeTreeData = this.emitter.event;

	readonly dragMimeTypes = [DND_MIME];
	readonly dropMimeTypes = [DND_MIME];

	private state: FilterState;
	private lastRegexError: string | undefined;
	view?: vscode.TreeView<TreeElement>;

	constructor(
		private readonly store: HistoryStore,
		private readonly workspaceMemento: vscode.Memento,
	) {
		const saved = workspaceMemento.get<FilterState>(FILTER_STATE_KEY);
		this.state = { ...DEFAULT_FILTER_STATE, ...saved };
		if (this.state.scope === 'workspace' && !hasWorkspace()) {
			this.state.scope = 'global';
		}
		store.onDidChange(() => this.refresh());
	}

	getFilterState(): Readonly<FilterState> {
		return this.state;
	}

	getTreeItem(element: TreeElement): vscode.TreeItem {
		return element;
	}

	getChildren(element?: TreeElement): TreeElement[] {
		if (element instanceof FolderTreeItem) {
			return this.entriesInFolder(element.folder.id).map((e) => new SearchHistoryItem(e));
		}
		if (element instanceof SearchHistoryItem) {
			return [];
		}
		return this.rootChildren();
	}

	/** Flat list of entries currently visible under the active filter/scope. */
	visibleEntries(): SearchHistoryEntry[] {
		const result = filterEntries(this.store.getAll(), this.state, {
			currentWorkspaceId: currentWorkspace().id,
		});
		this.lastRegexError = result.regexError;
		return result.entries;
	}

	/** Folders visible for the active scope, sorted by name. */
	foldersForCurrentScope(): SearchFolder[] {
		const ws = currentWorkspace().id;
		const folders = this.store.getFolders().filter((f) => {
			if (this.state.scope === 'global') {
				return true;
			}
			// Workspace scope shows global folders plus this workspace's own folders.
			return f.scope === 'global' || f.workspaceId === ws;
		});
		return folders.toSorted((a, b) => a.name.localeCompare(b.name));
	}

	/** Where a newly created folder should live, based on the current scope. */
	newFolderTarget(): { scope: Scope; workspaceId: string } {
		if (this.state.scope === 'workspace' && hasWorkspace()) {
			return { scope: 'workspace', workspaceId: currentWorkspace().id };
		}
		return { scope: 'global', workspaceId: '' };
	}

	private rootChildren(): TreeElement[] {
		const entries = this.visibleEntries();
		const folders = this.foldersForCurrentScope();
		const folderIds = new Set(folders.map((f) => f.id));

		const counts = new Map<string, number>();
		const ungrouped: SearchHistoryEntry[] = [];
		for (const entry of entries) {
			if (entry.folderId && folderIds.has(entry.folderId)) {
				counts.set(entry.folderId, (counts.get(entry.folderId) ?? 0) + 1);
			} else {
				ungrouped.push(entry);
			}
		}

		// While narrowing (text / tags / favorites), hide folders with no matches;
		// otherwise always show folders so they remain usable as drop targets.
		const narrowing =
			this.state.text.trim() !== '' || this.state.favoritesOnly || this.state.tags.length > 0;
		const folderItems = folders
			.filter((f) => !narrowing || (counts.get(f.id) ?? 0) > 0)
			.map((f) => new FolderTreeItem(f, counts.get(f.id) ?? 0));

		this.updateViewChrome(entries.length, folderItems.length);
		return [...folderItems, ...ungrouped.map((e) => new SearchHistoryItem(e))];
	}

	private entriesInFolder(folderId: string): SearchHistoryEntry[] {
		return this.visibleEntries().filter((e) => e.folderId === folderId);
	}

	refresh(): void {
		this.emitter.fire();
		void this.syncContext();
	}

	async setState(patch: Partial<FilterState>): Promise<void> {
		this.state = { ...this.state, ...patch };
		await this.workspaceMemento.update(FILTER_STATE_KEY, this.state);
		this.refresh();
	}

	async setScope(scope: Scope): Promise<void> {
		await this.setState({ scope });
	}

	/** Push filter/scope flags into VS Code context keys used by menu `when` clauses. */
	async syncContext(): Promise<void> {
		const set = (key: string, value: unknown) =>
			vscode.commands.executeCommand('setContext', key, value);
		await Promise.all([
			set('searchHistory.scope', this.state.scope),
			set('searchHistory.favoritesOnly', this.state.favoritesOnly),
			set('searchHistory.filterRegex', this.state.useRegex),
			set('searchHistory.hasFilter', this.state.text.trim() !== '' || this.state.tags.length > 0),
			set('searchHistory.hasWorkspace', hasWorkspace()),
		]);
	}

	// --- Drag & drop ---------------------------------------------------------

	handleDrag(source: readonly TreeElement[], dataTransfer: vscode.DataTransfer): void {
		const ids = source
			.filter((item): item is SearchHistoryItem => item instanceof SearchHistoryItem)
			.map((item) => item.entry.id);
		if (ids.length > 0) {
			dataTransfer.set(DND_MIME, new vscode.DataTransferItem(ids));
		}
	}

	async handleDrop(target: TreeElement | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
		const transferItem = dataTransfer.get(DND_MIME);
		if (!transferItem) {
			return;
		}
		const ids = transferItem.value as string[];
		// Drop on a folder → into it; on an entry → into that entry's folder;
		// on empty space → ungroup.
		let folderId: string | undefined;
		if (target instanceof FolderTreeItem) {
			folderId = target.folder.id;
		} else if (target instanceof SearchHistoryItem) {
			folderId = target.entry.folderId;
		}
		for (const id of ids) {
			await this.store.moveEntryToFolder(id, folderId);
		}
	}

	private updateViewChrome(entryCount: number, folderCount: number): void {
		if (!this.view) {
			return;
		}
		const scopeLabel = this.state.scope === 'global' ? 'Global' : currentWorkspace().name;
		const parts: string[] = [
			`${scopeLabel} · ${entryCount} ${entryCount === 1 ? 'search' : 'searches'}` +
				(folderCount > 0 ? ` · ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}` : ''),
		];
		if (this.state.text.trim() !== '') {
			parts.push(
				`filter: ${this.state.useRegex ? '/' : '"'}${this.state.text}${this.state.useRegex ? '/' : '"'}`,
			);
		}
		if (this.state.tags.length > 0) {
			parts.push(`tags: ${this.state.tags.join(', ')}`);
		}
		if (this.state.favoritesOnly) {
			parts.push('favorites only');
		}
		if (this.lastRegexError) {
			parts.push(`⚠ invalid regex: ${this.lastRegexError}`);
		}
		this.view.message = parts.join('  •  ');
	}
}

function describeEntry(entry: SearchHistoryEntry): string {
	const bits: string[] = [relativeTime(entry.lastUsedAt)];
	const flags = flagBadges(entry);
	if (flags) {
		bits.push(flags);
	}
	if (entry.tags.length > 0) {
		bits.push(entry.tags.map((t) => `#${t}`).join(' '));
	}
	return bits.join('  ·  ');
}

function flagBadges(entry: SearchHistoryEntry): string {
	const badges: string[] = [];
	if (entry.isRegex) {
		badges.push('.*');
	}
	if (entry.isCaseSensitive) {
		badges.push('Aa');
	}
	if (entry.matchWholeWord) {
		badges.push('|ab|');
	}
	return badges.join(' ');
}

function buildTooltip(entry: SearchHistoryEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.appendMarkdown(`**Query:** \`${escapeMd(entry.query)}\`\n\n`);
	md.appendMarkdown(`- **Workspace:** ${escapeMd(entry.workspaceName)}\n`);
	md.appendMarkdown(`- **Last used:** ${new Date(entry.lastUsedAt).toLocaleString()} (${entry.useCount}×)\n`);
	md.appendMarkdown(
		`- **Flags:** Regex ${bool(entry.isRegex)} · Match Case ${bool(entry.isCaseSensitive)} · Whole Word ${bool(
			entry.matchWholeWord,
		)}\n`,
	);
	if (entry.replaceText) {
		md.appendMarkdown(`- **Replace:** \`${escapeMd(entry.replaceText)}\`\n`);
	}
	if (entry.filesToInclude) {
		md.appendMarkdown(`- **Include:** \`${escapeMd(entry.filesToInclude)}\`\n`);
	}
	if (entry.filesToExclude) {
		md.appendMarkdown(`- **Exclude:** \`${escapeMd(entry.filesToExclude)}\`\n`);
	}
	if (entry.tags.length > 0) {
		md.appendMarkdown(`- **Tags:** ${entry.tags.map((t) => `\`${escapeMd(t)}\``).join(', ')}\n`);
	}
	if (entry.note) {
		md.appendMarkdown(`- **Note:** ${escapeMd(entry.note)}\n`);
	}
	if (entry.favorite) {
		md.appendMarkdown(`- $(star-full) Favorite\n`);
	}
	md.appendMarkdown(`\n_Click to run this search · drag onto a folder to group it._`);
	return md;
}

function bool(value: boolean): string {
	return value ? 'on' : 'off';
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, (m) => `\\${m}`);
}

function relativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const sec = Math.round(diff / 1000);
	if (sec < 45) {
		return 'just now';
	}
	const min = Math.round(sec / 60);
	if (min < 60) {
		return `${min}m ago`;
	}
	const hr = Math.round(min / 60);
	if (hr < 24) {
		return `${hr}h ago`;
	}
	const day = Math.round(hr / 24);
	if (day < 30) {
		return `${day}d ago`;
	}
	return new Date(timestamp).toLocaleDateString();
}
