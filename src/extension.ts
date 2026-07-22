import * as vscode from 'vscode';

import { FolderTreeItem, HistoryTreeProvider, SearchHistoryItem } from './historyProvider';
import { SearchBarViewProvider } from './searchBarView';
import { triggerNativeSearch } from './searchRunner';
import { HistoryStore, type HistoryStoreOptions } from './storage';
import type { SearchFolder, SearchHistoryEntry, SearchParams } from './types';
import { currentWorkspace, hasWorkspace } from './workspace';

function readOptions(): HistoryStoreOptions {
	const config = vscode.workspace.getConfiguration('searchHistory');
	return {
		maxEntries: config.get<number>('maxEntries', 5000),
		deduplicate: config.get<boolean>('deduplicate', true),
	};
}

/** Resolve the entry the user acted on, whether from a tree click or the palette. */
async function resolveEntry(
	provider: HistoryTreeProvider,
	arg: unknown,
): Promise<SearchHistoryEntry | undefined> {
	if (arg instanceof SearchHistoryItem) {
		return arg.entry;
	}
	const entries = provider.visibleEntries();
	if (entries.length === 0) {
		void vscode.window.showInformationMessage('There is no search history yet.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		entries.map((entry) => ({
			label: entry.query,
			description: entry.tags.map((t) => `#${t}`).join(' '),
			detail: `${entry.workspaceName} · ${entry.useCount}×`,
			entry,
		})),
		{ title: 'Select a search', matchOnDescription: true, matchOnDetail: true },
	);
	return pick?.entry;
}

/** Resolve the folder the user acted on, from a tree item or a picker. */
async function resolveFolder(
	provider: HistoryTreeProvider,
	arg: unknown,
): Promise<SearchFolder | undefined> {
	if (arg instanceof FolderTreeItem) {
		return arg.folder;
	}
	const folders = provider.foldersForCurrentScope();
	if (folders.length === 0) {
		void vscode.window.showInformationMessage('There are no folders yet.');
		return undefined;
	}
	const pick = await vscode.window.showQuickPick(
		folders.map((folder) => ({ label: folder.name, description: folder.scope, folder })),
		{ title: 'Select a folder' },
	);
	return pick?.folder;
}

/** Prompt for a name and create a folder in the scope implied by the current view. */
async function createFolderInteractive(
	store: HistoryStore,
	provider: HistoryTreeProvider,
): Promise<SearchFolder | undefined> {
	const target = provider.newFolderTarget();
	const name = await vscode.window.showInputBox({
		title: target.scope === 'workspace' ? 'New workspace folder' : 'New global folder',
		prompt: 'Name for the folder',
		ignoreFocusOut: true,
		validateInput: (value) => (value.trim() === '' ? 'The folder name cannot be empty.' : undefined),
	});
	if (name === undefined) {
		return undefined;
	}
	return store.createFolder(name, target.scope, target.workspaceId);
}

export function activate(context: vscode.ExtensionContext): void {
	const store = new HistoryStore(context.globalState, readOptions());
	const provider = new HistoryTreeProvider(store, context.workspaceState);

	const view = vscode.window.createTreeView('searchHistory.view', {
		treeDataProvider: provider,
		dragAndDropController: provider,
		showCollapseAll: true,
		canSelectMany: true,
	});
	provider.view = view;
	void provider.syncContext();
	provider.refresh();

	// The native-style search bar: records every search launched through it, runs
	// it in-view, and can hand off to VS Code's native panel on request.
	const recordSearch = (params: SearchParams): Promise<SearchHistoryEntry> => {
		const ws = currentWorkspace();
		return store.record({ ...params, workspaceId: ws.id, workspaceName: ws.name });
	};
	const searchBar = new SearchBarViewProvider(context.extensionUri, store, {
		record: recordSearch,
		openInNative: triggerNativeSearch,
	});
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SearchBarViewProvider.viewId, searchBar, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	const register = (command: string, handler: (...args: unknown[]) => unknown) =>
		context.subscriptions.push(vscode.commands.registerCommand(command, handler));

	// Both the title-bar "+" and the Ctrl+Shift+F keybinding land here: reveal the
	// search bar and focus its query field, so every search flows through it.
	register('searchHistory.newSearch', () => searchBar.focus());

	register('searchHistory.runEntry', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (entry) {
			await store.touch(entry.id);
			await searchBar.prefillAndRun(entry);
		}
	});

	const setFavorite = async (arg: unknown, favorite: boolean) => {
		const entry = await resolveEntry(provider, arg);
		if (entry) {
			await store.setFavorite(entry.id, favorite);
		}
	};
	register('searchHistory.addFavorite', (arg) => setFavorite(arg, true));
	register('searchHistory.removeFavorite', (arg) => setFavorite(arg, false));
	register('searchHistory.toggleFavorite', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (entry) {
			await store.toggleFavorite(entry.id);
		}
	});

	register('searchHistory.copyQuery', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (entry) {
			await vscode.env.clipboard.writeText(entry.query);
			void vscode.window.showInformationMessage('Search query copied to clipboard.');
		}
	});

	register('searchHistory.editTags', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (!entry) {
			return;
		}
		const value = await vscode.window.showInputBox({
			title: 'Edit tags',
			prompt: 'Comma-separated tags for this search',
			value: entry.tags.join(', '),
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return;
		}
		await store.setTags(
			entry.id,
			value.split(',').map((t) => t.trim()),
		);
	});

	register('searchHistory.editNote', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (!entry) {
			return;
		}
		const value = await vscode.window.showInputBox({
			title: 'Edit note',
			prompt: 'A free-text note to remember why you ran this search',
			value: entry.note,
			ignoreFocusOut: true,
		});
		if (value === undefined) {
			return;
		}
		await store.setNote(entry.id, value);
	});

	register('searchHistory.deleteEntry', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (!entry) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Delete search "${entry.query}"?`,
			{ modal: true },
			'Delete',
		);
		if (confirm === 'Delete') {
			await store.remove(entry.id);
		}
	});

	// --- Folders -------------------------------------------------------------

	register('searchHistory.newFolder', () => createFolderInteractive(store, provider));

	register('searchHistory.renameFolder', async (arg) => {
		const folder = await resolveFolder(provider, arg);
		if (!folder) {
			return;
		}
		const name = await vscode.window.showInputBox({
			title: 'Rename folder',
			value: folder.name,
			ignoreFocusOut: true,
			validateInput: (value) => (value.trim() === '' ? 'The folder name cannot be empty.' : undefined),
		});
		if (name !== undefined) {
			await store.renameFolder(folder.id, name);
		}
	});

	register('searchHistory.deleteFolder', async (arg) => {
		const folder = await resolveFolder(provider, arg);
		if (!folder) {
			return;
		}
		const confirm = await vscode.window.showWarningMessage(
			`Delete folder "${folder.name}"? Its searches are kept and moved to Ungrouped.`,
			{ modal: true },
			'Delete Folder',
		);
		if (confirm === 'Delete Folder') {
			await store.deleteFolder(folder.id);
		}
	});

	register('searchHistory.moveToFolder', async (arg) => {
		const entry = await resolveEntry(provider, arg);
		if (!entry) {
			return;
		}
		const NEW = '\0new';
		const UNGROUP = '\0ungroup';
		const items: (vscode.QuickPickItem & { target: string | undefined })[] = [
			{ label: '$(new-folder) New folder…', target: NEW },
			{ label: '$(circle-slash) Remove from folder', target: UNGROUP },
			{
				label: 'Folders',
				kind: vscode.QuickPickItemKind.Separator,
				target: undefined,
			},
			...provider.foldersForCurrentScope().map((folder) => ({
				label: `$(folder) ${folder.name}`,
				description: folder.scope,
				target: folder.id,
			})),
		];
		const pick = await vscode.window.showQuickPick(items, {
			title: `Move "${entry.query}" to…`,
		});
		if (!pick || pick.kind === vscode.QuickPickItemKind.Separator) {
			return;
		}
		let target = pick.target;
		if (target === NEW) {
			const created = await createFolderInteractive(store, provider);
			if (!created) {
				return;
			}
			target = created.id;
		} else if (target === UNGROUP) {
			target = undefined;
		}
		await store.moveEntryToFolder(entry.id, target);
	});

	// --- History maintenance -------------------------------------------------

	register('searchHistory.clearHistory', async () => {
		const state = provider.getFilterState();
		const scopedToWorkspace = state.scope === 'workspace' && hasWorkspace();
		const options: string[] = scopedToWorkspace
			? ['Clear This Workspace', 'Clear Everything']
			: ['Clear Everything'];
		const choice = await vscode.window.showWarningMessage(
			'Clear search history? This cannot be undone.',
			{ modal: true },
			...options,
		);
		if (choice === 'Clear Everything') {
			await store.clear();
		} else if (choice === 'Clear This Workspace') {
			await store.clear(currentWorkspace().id);
		}
	});

	// --- Filtering -----------------------------------------------------------

	register('searchHistory.setFilter', async () => {
		const state = provider.getFilterState();
		const value = await vscode.window.showInputBox({
			title: state.useRegex ? 'Filter history (regex)' : 'Filter history (text)',
			prompt: 'Matches query, tags, workspace and include/exclude patterns',
			value: state.text,
			ignoreFocusOut: true,
		});
		if (value !== undefined) {
			await provider.setState({ text: value });
		}
	});

	register('searchHistory.filterByTag', async () => {
		const tags = store.allTags();
		if (tags.length === 0) {
			void vscode.window.showInformationMessage('No tags yet — add tags to a search first.');
			return;
		}
		const active = new Set(provider.getFilterState().tags.map((t) => t.toLowerCase()));
		const picks = await vscode.window.showQuickPick(
			tags.map((tag) => ({ label: tag, picked: active.has(tag.toLowerCase()) })),
			{ title: 'Filter by tag', canPickMany: true },
		);
		if (picks) {
			await provider.setState({ tags: picks.map((p) => p.label) });
		}
	});

	register('searchHistory.clearFilter', () => provider.setState({ text: '', tags: [] }));
	register('searchHistory.enableRegexFilter', () => provider.setState({ useRegex: true }));
	register('searchHistory.disableRegexFilter', () => provider.setState({ useRegex: false }));
	register('searchHistory.showFavoritesOnly', () => provider.setState({ favoritesOnly: true }));
	register('searchHistory.showAllEntries', () => provider.setState({ favoritesOnly: false }));
	register('searchHistory.useGlobalScope', () => provider.setScope('global'));
	register('searchHistory.useWorkspaceScope', () => provider.setScope('workspace'));
	register('searchHistory.refresh', () => provider.refresh());

	context.subscriptions.push(
		view,
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('searchHistory')) {
				store.updateOptions(readOptions());
				provider.refresh();
				void searchBar.pushConfig();
			}
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.syncContext()),
	);
}

export function deactivate(): void {
	// Nothing to clean up: state lives in the extension's Memento storage.
}
