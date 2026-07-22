import * as assert from 'assert';

import * as vscode from 'vscode';

const EXTENSION_ID = 'ActiveClientMods.vscode-search-history';

suite('extension integration', () => {
	test('extension is present and activates', async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(ext, 'extension should be discoverable by id');
		await ext.activate();
		assert.strictEqual(ext.isActive, true);
	});

	test('core commands are registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		const expected = [
			'searchHistory.newSearch',
			'searchHistory.runEntry',
			'searchHistory.toggleFavorite',
			'searchHistory.addFavorite',
			'searchHistory.removeFavorite',
			'searchHistory.editTags',
			'searchHistory.deleteEntry',
			'searchHistory.clearHistory',
			'searchHistory.setFilter',
			'searchHistory.filterByTag',
			'searchHistory.enableRegexFilter',
			'searchHistory.disableRegexFilter',
			'searchHistory.useGlobalScope',
			'searchHistory.useWorkspaceScope',
			'searchHistory.newFolder',
			'searchHistory.renameFolder',
			'searchHistory.deleteFolder',
			'searchHistory.moveToFolder',
		];
		for (const command of expected) {
			assert.ok(commands.includes(command), `missing command: ${command}`);
		}
	});

	test('filter/scope commands execute without throwing', async () => {
		const ext = vscode.extensions.getExtension(EXTENSION_ID);
		await ext?.activate();
		// These mutate provider state and set context keys; they must be safe to
		// invoke even with an empty history.
		await vscode.commands.executeCommand('searchHistory.enableRegexFilter');
		await vscode.commands.executeCommand('searchHistory.disableRegexFilter');
		await vscode.commands.executeCommand('searchHistory.showFavoritesOnly');
		await vscode.commands.executeCommand('searchHistory.showAllEntries');
		await vscode.commands.executeCommand('searchHistory.useGlobalScope');
		await vscode.commands.executeCommand('searchHistory.clearFilter');
		await vscode.commands.executeCommand('searchHistory.refresh');
	});
});
