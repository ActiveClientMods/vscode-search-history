// Commands for creating, renaming, deleting folders and moving entries between
// them.

import * as vscode from 'vscode';

import type { CommandDeps, RegisterFn } from './deps';
import { createFolderInteractive, resolveEntry, resolveFolder } from './helpers';

export function registerFolderCommands(register: RegisterFn, { store, provider }: CommandDeps): void {
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
}
