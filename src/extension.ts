import * as vscode from 'vscode';

import { registerCommands } from './commands';
import { HistoryStore, type HistoryStoreOptions } from './core/storage';
import type { SearchHistoryEntry, SearchParams } from './core/types';
import { currentWorkspace } from './core/workspace';
import { triggerNativeSearch } from './search/searchRunner';
import { HistoryTreeProvider } from './views/historyProvider';
import { SearchBarViewProvider } from './views/searchBarView';

function readOptions(): HistoryStoreOptions {
	const config = vscode.workspace.getConfiguration('searchHistory');
	return {
		maxEntries: config.get<number>('maxEntries', 5000),
		deduplicate: config.get<boolean>('deduplicate', true),
	};
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

	registerCommands(context, { store, provider, searchBar });

	context.subscriptions.push(
		view,
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('searchHistory')) {
				store.updateOptions(readOptions());
				provider.refresh();
				void searchBar.pushConfig();
			}
		}),
		// Live-refresh the in-view results as files are edited, like the native
		// Search view. The provider debounces and ignores this unless a search is
		// currently shown.
		vscode.workspace.onDidChangeTextDocument((e) => searchBar.onDocumentChanged(e)),
		vscode.workspace.onDidChangeWorkspaceFolders(() => provider.syncContext()),
	);
}

export function deactivate(): void {
	// Nothing to clean up: state lives in the extension's Memento storage.
}
