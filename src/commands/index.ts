// Command registration entry point: wires every `searchHistory.*` command to its
// handler, grouped by concern (entries, folders, filtering/maintenance).

import * as vscode from 'vscode';

import type { CommandDeps, RegisterFn } from './deps';
import { registerEntryCommands } from './entryCommands';
import { registerFilterCommands } from './filterCommands';
import { registerFolderCommands } from './folderCommands';

export type { CommandDeps } from './deps';

export function registerCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
	const register: RegisterFn = (command, handler) =>
		context.subscriptions.push(vscode.commands.registerCommand(command, handler));

	registerEntryCommands(register, deps);
	registerFolderCommands(register, deps);
	registerFilterCommands(register, deps);
}
