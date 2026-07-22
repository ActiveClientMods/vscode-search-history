import * as vscode from 'vscode';

import type { SearchParams } from './types';

/**
 * Trigger VS Code's native "Find in Files" search pre-filled with the exact
 * query, flags and include/exclude patterns of the given parameters.
 */
export async function triggerNativeSearch(params: SearchParams): Promise<void> {
	await vscode.commands.executeCommand('workbench.action.findInFiles', {
		query: params.query,
		replace: params.replaceText,
		triggerSearch: true,
		isRegex: params.isRegex,
		isCaseSensitive: params.isCaseSensitive,
		matchWholeWord: params.matchWholeWord,
		filesToInclude: params.filesToInclude,
		filesToExclude: params.filesToExclude,
	});
}
