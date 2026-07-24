// Commands acting on individual history entries: running, favoriting, tagging,
// noting, copying and deleting — plus the "new search" entry point.

import * as vscode from 'vscode';

import type { CommandDeps, RegisterFn } from './deps';
import { resolveEntry } from './helpers';

export function registerEntryCommands(register: RegisterFn, { store, provider, searchBar }: CommandDeps): void {
	// Both the title-bar "+" and the Ctrl+Shift+F keybinding land here: reveal the
	// search bar and focus its query field, so every search flows through it.
	register('searchHistory.newSearch', () => searchBar.focus());

	// Search-bar title-bar actions: wipe the input fields, or reset the match options.
	register('searchHistory.clearSearchInputs', () => searchBar.clearInputs());
	register('searchHistory.clearSearchOptions', () => searchBar.clearOptions());

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
}
