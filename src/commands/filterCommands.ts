// Commands that shape what the history view shows: filtering, scope, favorites,
// refresh — plus the destructive "clear history" maintenance action.

import * as vscode from 'vscode';

import { currentWorkspace, hasWorkspace } from '../core/workspace';
import type { CommandDeps, RegisterFn } from './deps';

export function registerFilterCommands(register: RegisterFn, { store, provider }: CommandDeps): void {
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
}
