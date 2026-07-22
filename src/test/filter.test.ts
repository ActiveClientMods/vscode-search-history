import * as assert from 'assert';

import { filterEntries, sortEntries } from '../filter';
import type { FilterState, SearchHistoryEntry } from '../types';

function entry(partial: Partial<SearchHistoryEntry>): SearchHistoryEntry {
	return {
		id: partial.id ?? Math.random().toString(36).slice(2),
		query: partial.query ?? 'foo',
		isRegex: partial.isRegex ?? false,
		isCaseSensitive: partial.isCaseSensitive ?? false,
		matchWholeWord: partial.matchWholeWord ?? false,
		filesToInclude: partial.filesToInclude ?? '',
		filesToExclude: partial.filesToExclude ?? '',
		workspaceId: partial.workspaceId ?? 'ws-a',
		workspaceName: partial.workspaceName ?? 'Workspace A',
		createdAt: partial.createdAt ?? 1000,
		lastUsedAt: partial.lastUsedAt ?? 1000,
		useCount: partial.useCount ?? 1,
		favorite: partial.favorite ?? false,
		tags: partial.tags ?? [],
	};
}

const baseState: FilterState = {
	text: '',
	useRegex: false,
	favoritesOnly: false,
	tags: [],
	scope: 'global',
};

suite('filter', () => {
	test('substring text filter matches query case-insensitively', () => {
		const entries = [entry({ query: 'TODO handler' }), entry({ query: 'unrelated' })];
		const result = filterEntries(entries, { ...baseState, text: 'todo' }, { currentWorkspaceId: 'ws-a' });
		assert.strictEqual(result.entries.length, 1);
		assert.strictEqual(result.entries[0].query, 'TODO handler');
	});

	test('text filter also matches tags and workspace name', () => {
		const entries = [
			entry({ query: 'a', tags: ['bug'] }),
			entry({ query: 'b', workspaceName: 'Payments Service' }),
			entry({ query: 'c' }),
		];
		assert.strictEqual(
			filterEntries(entries, { ...baseState, text: 'bug' }, { currentWorkspaceId: 'ws-a' }).entries.length,
			1,
		);
		assert.strictEqual(
			filterEntries(entries, { ...baseState, text: 'payments' }, { currentWorkspaceId: 'ws-a' }).entries
				.length,
			1,
		);
	});

	test('regex filter matches and reports invalid patterns', () => {
		const entries = [entry({ query: 'errorCode42' }), entry({ query: 'plain' })];
		const ok = filterEntries(entries, { ...baseState, text: 'error\\w+\\d+', useRegex: true }, {
			currentWorkspaceId: 'ws-a',
		});
		assert.strictEqual(ok.entries.length, 1);
		assert.strictEqual(ok.regexError, undefined);

		const bad = filterEntries(entries, { ...baseState, text: '(', useRegex: true }, {
			currentWorkspaceId: 'ws-a',
		});
		assert.strictEqual(bad.entries.length, 0);
		assert.ok(bad.regexError, 'expected a regex error message');
	});

	test('favoritesOnly keeps only favorites', () => {
		const entries = [entry({ favorite: true, query: 'fav' }), entry({ favorite: false, query: 'nope' })];
		const result = filterEntries(entries, { ...baseState, favoritesOnly: true }, {
			currentWorkspaceId: 'ws-a',
		});
		assert.deepStrictEqual(
			result.entries.map((e) => e.query),
			['fav'],
		);
	});

	test('workspace scope filters by current workspace id', () => {
		const entries = [
			entry({ query: 'here', workspaceId: 'ws-a' }),
			entry({ query: 'there', workspaceId: 'ws-b' }),
		];
		const result = filterEntries(entries, { ...baseState, scope: 'workspace' }, {
			currentWorkspaceId: 'ws-a',
		});
		assert.deepStrictEqual(
			result.entries.map((e) => e.query),
			['here'],
		);
	});

	test('tag filter requires every selected tag', () => {
		const entries = [
			entry({ query: 'both', tags: ['bug', 'urgent'] }),
			entry({ query: 'one', tags: ['bug'] }),
		];
		const result = filterEntries(entries, { ...baseState, tags: ['bug', 'urgent'] }, {
			currentWorkspaceId: 'ws-a',
		});
		assert.deepStrictEqual(
			result.entries.map((e) => e.query),
			['both'],
		);
	});

	test('sortEntries pins favorites, then most-recent-first', () => {
		const sorted = sortEntries([
			entry({ id: 'old', lastUsedAt: 100 }),
			entry({ id: 'fav', favorite: true, lastUsedAt: 50 }),
			entry({ id: 'new', lastUsedAt: 300 }),
		]);
		assert.deepStrictEqual(
			sorted.map((e) => e.id),
			['fav', 'new', 'old'],
		);
	});
});
