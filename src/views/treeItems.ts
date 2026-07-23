// TreeItem subclasses rendered in the Search History view.

import * as vscode from 'vscode';

import type { SearchFolder, SearchHistoryEntry } from '../core/types';
import { buildTooltip, describeEntry } from './treeFormatting';

/** Tree item wrapping a single history entry. */
export class SearchHistoryItem extends vscode.TreeItem {
	constructor(
		public readonly entry: SearchHistoryEntry,
		favoriteIcon: vscode.Uri,
	) {
		super(entry.query, vscode.TreeItemCollapsibleState.None);

		this.id = entry.id;
		this.contextValue = entry.favorite ? 'searchEntry.favorite' : 'searchEntry';
		// Favorites get a leading filled gold star as an at-a-glance indicator;
		// non-favorites show no leading icon at all. We use a bundled SVG rather than
		// a themed `star-full` codicon on purpose: the tree recolors themed icons to
		// the selection foreground when a row is selected (turning the gold star
		// white), whereas a custom image keeps its own color. The hover inline button
		// and the right-click menu still perform the actual toggle.
		this.iconPath = entry.favorite ? favoriteIcon : undefined;
		this.description = describeEntry(entry);
		this.tooltip = buildTooltip(entry);
		this.command = {
			command: 'searchHistory.runEntry',
			title: 'Run Search',
			arguments: [this],
		};
	}
}

/** Tree item for a folder grouping entries. */
export class FolderTreeItem extends vscode.TreeItem {
	constructor(
		public readonly folder: SearchFolder,
		count: number,
	) {
		super(folder.name, vscode.TreeItemCollapsibleState.Expanded);

		this.id = `folder:${folder.id}`;
		this.contextValue = 'searchFolder';
		this.iconPath = new vscode.ThemeIcon('folder');
		this.description = folder.scope === 'workspace' ? `${count} · workspace` : `${count}`;
		this.tooltip = new vscode.MarkdownString(
			`**${folder.name}**\n\n${count} ${count === 1 ? 'search' : 'searches'} · ${
				folder.scope === 'workspace' ? 'workspace folder' : 'global folder'
			}`,
		);
	}
}

export type TreeElement = FolderTreeItem | SearchHistoryItem;
