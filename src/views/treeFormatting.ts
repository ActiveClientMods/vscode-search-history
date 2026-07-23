// Presentation helpers for the history tree: how an entry's label, description
// and tooltip are rendered. Kept apart from the TreeItem classes so the display
// formatting can evolve (and be read) on its own.

import * as vscode from 'vscode';

import type { SearchHistoryEntry } from '../core/types';

export function describeEntry(entry: SearchHistoryEntry): string {
	const bits: string[] = [relativeTime(entry.lastUsedAt)];
	const flags = flagBadges(entry);
	if (flags) {
		bits.push(flags);
	}
	if (entry.tags.length > 0) {
		bits.push(entry.tags.map((t) => `#${t}`).join(' '));
	}
	return bits.join('  ·  ');
}

function flagBadges(entry: SearchHistoryEntry): string {
	const badges: string[] = [];
	if (entry.isRegex) {
		badges.push('.*');
	}
	if (entry.isCaseSensitive) {
		badges.push('Aa');
	}
	if (entry.matchWholeWord) {
		badges.push('|ab|');
	}
	return badges.join(' ');
}

export function buildTooltip(entry: SearchHistoryEntry): vscode.MarkdownString {
	const md = new vscode.MarkdownString(undefined, true);
	md.appendMarkdown(`**Query:** \`${escapeMd(entry.query)}\`\n\n`);
	md.appendMarkdown(`- **Workspace:** ${escapeMd(entry.workspaceName)}\n`);
	md.appendMarkdown(`- **Last used:** ${new Date(entry.lastUsedAt).toLocaleString()} (${entry.useCount}×)\n`);
	md.appendMarkdown(
		`- **Flags:** Regex ${bool(entry.isRegex)} · Match Case ${bool(entry.isCaseSensitive)} · Whole Word ${bool(
			entry.matchWholeWord,
		)}\n`,
	);
	if (entry.replaceText) {
		md.appendMarkdown(`- **Replace:** \`${escapeMd(entry.replaceText)}\`\n`);
	}
	if (entry.filesToInclude) {
		md.appendMarkdown(`- **Include:** \`${escapeMd(entry.filesToInclude)}\`\n`);
	}
	if (entry.filesToExclude) {
		md.appendMarkdown(`- **Exclude:** \`${escapeMd(entry.filesToExclude)}\`\n`);
	}
	if (entry.tags.length > 0) {
		md.appendMarkdown(`- **Tags:** ${entry.tags.map((t) => `\`${escapeMd(t)}\``).join(', ')}\n`);
	}
	if (entry.note) {
		md.appendMarkdown(`- **Note:** ${escapeMd(entry.note)}\n`);
	}
	if (entry.favorite) {
		md.appendMarkdown(`- $(star-full) Favorite\n`);
	}
	md.appendMarkdown(`\n_Click to run this search · drag onto a folder to group it._`);
	return md;
}

function bool(value: boolean): string {
	return value ? 'on' : 'off';
}

function escapeMd(text: string): string {
	return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, (m) => `\\${m}`);
}

export function relativeTime(timestamp: number): string {
	const diff = Date.now() - timestamp;
	const sec = Math.round(diff / 1000);
	if (sec < 45) {
		return 'just now';
	}
	const min = Math.round(sec / 60);
	if (min < 60) {
		return `${min}m ago`;
	}
	const hr = Math.round(min / 60);
	if (hr < 24) {
		return `${hr}h ago`;
	}
	const day = Math.round(hr / 24);
	if (day < 30) {
		return `${day}d ago`;
	}
	return new Date(timestamp).toLocaleDateString();
}
