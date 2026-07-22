import * as vscode from 'vscode';

export interface WorkspaceIdentity {
	/** Stable id derived from the open folder(s); empty when no folder is open. */
	id: string;
	/** Human-readable name for display in the history list. */
	name: string;
}

/**
 * Derive a stable identity for the currently open workspace. Multi-root folders
 * are combined so the same set of roots always maps to the same id.
 */
export function currentWorkspace(): WorkspaceIdentity {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders || folders.length === 0) {
		return { id: '', name: '(no workspace)' };
	}
	const id = folders
		.map((f) => f.uri.toString())
		.toSorted()
		.join('|');
	const name = vscode.workspace.name ?? folders[0].name;
	return { id, name };
}

export function hasWorkspace(): boolean {
	return currentWorkspace().id !== '';
}
