// Shared interactive helpers for resolving the entry/folder a command acts on,
// whether it was invoked from a tree item, the command palette, or a keybinding.

import * as vscode from 'vscode';

import type { HistoryStore } from '../core/storage';
import type { SearchFolder, SearchHistoryEntry } from '../core/types';
import type { HistoryTreeProvider } from '../views/historyProvider';
import { FolderTreeItem, SearchHistoryItem } from '../views/treeItems';

/** Resolve the entry the user acted on, whether from a tree click or the palette. */
export async function resolveEntry(
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
export async function resolveFolder(
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
export async function createFolderInteractive(
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
