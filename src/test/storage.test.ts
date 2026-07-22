import * as assert from 'assert';

import { HistoryStore, normalizeTags, type RecordInput } from '../storage';
import { FakeMemento } from './fakeMemento';

function input(partial: Partial<RecordInput> = {}): RecordInput {
	return {
		query: partial.query ?? 'needle',
		isRegex: partial.isRegex ?? false,
		isCaseSensitive: partial.isCaseSensitive ?? false,
		matchWholeWord: partial.matchWholeWord ?? false,
		filesToInclude: partial.filesToInclude ?? '',
		filesToExclude: partial.filesToExclude ?? '',
		workspaceId: partial.workspaceId ?? 'ws-a',
		workspaceName: partial.workspaceName ?? 'Workspace A',
	};
}

suite('storage', () => {
	test('record adds a new entry with sensible defaults', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const entry = await store.record(input({ query: 'hello' }));
		assert.strictEqual(entry.query, 'hello');
		assert.strictEqual(entry.useCount, 1);
		assert.strictEqual(entry.favorite, false);
		assert.deepStrictEqual(entry.tags, []);
		assert.strictEqual(store.getAll().length, 1);
	});

	test('dedupe bumps usage instead of creating duplicates', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const first = await store.record(input({ query: 'dup' }));
		const second = await store.record(input({ query: 'dup' }));
		assert.strictEqual(store.getAll().length, 1);
		assert.strictEqual(first.id, second.id);
		assert.strictEqual(store.getById(first.id)?.useCount, 2);
	});

	test('dedupe treats different flags as distinct searches', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		await store.record(input({ query: 'x', isRegex: false }));
		await store.record(input({ query: 'x', isRegex: true }));
		assert.strictEqual(store.getAll().length, 2);
	});

	test('deduplicate disabled always appends', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: false });
		await store.record(input({ query: 'same' }));
		await store.record(input({ query: 'same' }));
		assert.strictEqual(store.getAll().length, 2);
	});

	test('favorite and tags persist and survive a reload', async () => {
		const memento = new FakeMemento();
		const store = new HistoryStore(memento, { maxEntries: 100, deduplicate: true });
		const entry = await store.record(input({ query: 'star me' }));
		await store.toggleFavorite(entry.id);
		await store.setTags(entry.id, ['Bug', 'bug', ' urgent ', '']);

		const reloaded = new HistoryStore(memento, { maxEntries: 100, deduplicate: true });
		const persisted = reloaded.getById(entry.id);
		assert.strictEqual(persisted?.favorite, true);
		assert.deepStrictEqual(persisted?.tags, ['Bug', 'urgent']);
	});

	test('prune keeps favorites and drops oldest non-favorites first', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 2, deduplicate: false });
		const a = await store.record(input({ query: 'a' }));
		await store.toggleFavorite(a.id); // favorite, oldest
		await store.record(input({ query: 'b' }));
		await store.record(input({ query: 'c' }));
		await store.record(input({ query: 'd' }));

		const queries = store.getAll().map((e) => e.query).toSorted();
		assert.strictEqual(store.getAll().length, 2);
		assert.ok(queries.includes('a'), 'favorite must be retained');
		assert.ok(queries.includes('d'), 'newest must be retained');
	});

	test('clear with a workspace id only removes that workspace', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		await store.record(input({ query: 'a', workspaceId: 'ws-a' }));
		await store.record(input({ query: 'b', workspaceId: 'ws-b' }));
		await store.clear('ws-a');
		assert.deepStrictEqual(
			store.getAll().map((e) => e.workspaceId),
			['ws-b'],
		);
	});

	test('remove deletes a single entry and fires change', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		let changes = 0;
		store.onDidChange(() => (changes += 1));
		const entry = await store.record(input({ query: 'gone' }));
		await store.remove(entry.id);
		assert.strictEqual(store.getAll().length, 0);
		assert.ok(changes >= 2, 'record + remove should both notify');
	});

	test('setFavorite sets an explicit value', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const entry = await store.record(input({ query: 'x' }));
		await store.setFavorite(entry.id, true);
		assert.strictEqual(store.getById(entry.id)?.favorite, true);
		await store.setFavorite(entry.id, false);
		assert.strictEqual(store.getById(entry.id)?.favorite, false);
	});

	test('normalizeTags trims, de-dupes case-insensitively and drops empties', () => {
		assert.deepStrictEqual(normalizeTags([' a ', 'A', 'b', '', '  ']), ['a', 'b']);
	});
});

suite('storage · folders', () => {
	test('createFolder persists with the right scope and is retrievable', async () => {
		const memento = new FakeMemento();
		const store = new HistoryStore(memento, { maxEntries: 100, deduplicate: true });
		const global = await store.createFolder('Global topic', 'global', 'ws-a');
		const wsFolder = await store.createFolder('WS topic', 'workspace', 'ws-a');

		assert.strictEqual(global.scope, 'global');
		assert.strictEqual(global.workspaceId, '', 'global folders carry no workspace id');
		assert.strictEqual(wsFolder.workspaceId, 'ws-a');

		const reloaded = new HistoryStore(memento, { maxEntries: 100, deduplicate: true });
		assert.strictEqual(reloaded.getFolders().length, 2);
		assert.strictEqual(reloaded.getFolderById(wsFolder.id)?.name, 'WS topic');
	});

	test('moveEntryToFolder assigns and clears membership', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const entry = await store.record(input({ query: 'q' }));
		const folder = await store.createFolder('F', 'global', '');

		await store.moveEntryToFolder(entry.id, folder.id);
		assert.strictEqual(store.getById(entry.id)?.folderId, folder.id);

		await store.moveEntryToFolder(entry.id, undefined);
		assert.strictEqual(store.getById(entry.id)?.folderId, undefined);
	});

	test('deleteFolder keeps entries but ungroups them', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const entry = await store.record(input({ query: 'q' }));
		const folder = await store.createFolder('F', 'global', '');
		await store.moveEntryToFolder(entry.id, folder.id);

		await store.deleteFolder(folder.id);
		assert.strictEqual(store.getFolders().length, 0);
		assert.strictEqual(store.getAll().length, 1, 'entry is retained');
		assert.strictEqual(store.getById(entry.id)?.folderId, undefined, 'entry is ungrouped');
	});

	test('renameFolder updates the name, ignores blanks', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		const folder = await store.createFolder('Old', 'global', '');
		await store.renameFolder(folder.id, '  New  ');
		assert.strictEqual(store.getFolderById(folder.id)?.name, 'New');
		await store.renameFolder(folder.id, '   ');
		assert.strictEqual(store.getFolderById(folder.id)?.name, 'New', 'blank rename is ignored');
	});

	test('clear(workspaceId) removes workspace folders but keeps global ones', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		await store.createFolder('Global', 'global', '');
		await store.createFolder('WS', 'workspace', 'ws-a');
		await store.clear('ws-a');
		const names = store.getFolders().map((f) => f.name);
		assert.deepStrictEqual(names, ['Global']);
	});

	test('clear() wipes both entries and folders', async () => {
		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		await store.record(input({ query: 'q' }));
		await store.createFolder('F', 'global', '');
		await store.clear();
		assert.strictEqual(store.getAll().length, 0);
		assert.strictEqual(store.getFolders().length, 0);
	});
});
