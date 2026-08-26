// End-to-end tests for the search bar view: a fake webview stands in for the
// real one, so the whole search → render → replace path runs for real against
// files in the test workspace.
//
// Each of these guards a bug that shipped once:
//   * replacing was impossible — the Replace field existed but nothing acted on it;
//   * results went stale after edits, especially while the view was hidden;
//   * a match near the end of a long line was rendered off-screen.

import * as assert from 'assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

import { HistoryStore } from '../core/storage';
import type { SearchParams } from '../core/types';
import { CONTROL_IDS } from '../views/searchBarHtml';
import { SearchBarViewProvider } from '../views/searchBarView';
import { FakeMemento } from './fakeMemento';
import { FakeWebviewView } from './fakeWebviewView';

const EXTENSION_ID = 'ActiveClientMods.vscode-search-history';

function params(partial: Partial<SearchParams> & { query: string }): SearchParams {
	return {
		isRegex: false,
		isCaseSensitive: false,
		matchWholeWord: false,
		replaceText: '',
		filesToInclude: '',
		filesToExclude: '',
		...partial,
	};
}

suite('searchBar · in-view search, replace and staleness', () => {
	let provider: SearchBarViewProvider;
	let fake: FakeWebviewView;
	let extensionPath: string;
	let workspaceUri: vscode.Uri;
	const created: vscode.Uri[] = [];

	suiteSetup(async () => {
		const extension = vscode.extensions.getExtension(EXTENSION_ID);
		assert.ok(extension, 'extension should be discoverable');
		await extension.activate();
		extensionPath = extension.extensionPath;

		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder, 'the tests need an open workspace folder (see .vscode-test.mjs)');
		workspaceUri = folder.uri;

		const store = new HistoryStore(new FakeMemento(), { maxEntries: 100, deduplicate: true });
		provider = new SearchBarViewProvider(extension.extensionUri, store, {
			record: (p) => store.record({ ...p, workspaceId: 'test', workspaceName: 'test' }),
			openInNative: async () => {},
		});
		fake = new FakeWebviewView();
		provider.resolveWebviewView(fake.asWebviewView());
	});

	teardown(async () => {
		// Revert any unsaved edits a replace test left behind before deleting.
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
		for (const uri of created.splice(0)) {
			try {
				await vscode.workspace.fs.delete(uri);
			} catch {
				/* already gone */
			}
		}
	});

	/** Write a scratch file into the test workspace and remember it for cleanup. */
	async function writeFile(name: string, content: string): Promise<vscode.Uri> {
		const uri = vscode.Uri.joinPath(workspaceUri, name);
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
		created.push(uri);
		return uri;
	}

	/** Run a search through the bar exactly as the client script would. */
	async function search(p: SearchParams): Promise<{ done: any; files: any[] }> {
		fake.clearPosted();
		const finished = fake.nextMessage('searchDone');
		fake.send({ type: 'run', params: p });
		const done = await finished;
		const files = fake.messages('results').flatMap((m) => m.files);
		return { done, files };
	}

	/**
	 * The order the rows actually appear in: results stream in one message per
	 * file, each carrying the slot the webview splices it into.
	 */
	function listedOrder(files: any[]): string[] {
		const out: string[] = [];
		for (const file of files) {
			out.splice(file.index, 0, file.path);
		}
		return out;
	}

	function fileFor(files: any[], uri: vscode.Uri): any {
		const found = files.find((f) => f.uri === uri.toString());
		assert.ok(found, `expected results for ${uri.fsPath}, got ${files.map((f) => f.path).join(', ')}`);
		return found;
	}

	// --- Replace -------------------------------------------------------------

	test('the Replace All control exists and is wired to the host', async () => {
		// The original bug was not a broken replace — it was that no control ever
		// invoked one, so the field looked functional and did nothing.
		assert.ok(fake.webview.html.includes('id="replaceAll"'), 'the markup must contain a Replace All button');
		// It is an icon button, so its only name is the tooltip / accessible label.
		assert.ok(
			/id="replaceAll"[^>]*aria-label="Replace All"/.test(fake.webview.html),
			'the icon button must still be named for tooltips and screen readers',
		);

		const client = await fs.readFile(path.join(extensionPath, 'media', 'searchBar.js'), 'utf8');
		assert.ok(/postMessage\(\{\s*type:\s*'replaceAll'/.test(client), 'the client must post a replaceAll message');
		assert.ok(client.includes("type: 'replaceFile'"), 'the client must offer replace-all-in-file');
		assert.ok(client.includes("type: 'replaceMatches'"), 'the client must offer per-row replace');
		// Enter in the Replace field must replace, not search again.
		assert.ok(
			client.includes('input === els.replace'),
			'Enter inside the Replace field must be routed to replace',
		);
	});

	test('the client keeps the host in step with the list on screen', async () => {
		const client = await fs.readFile(path.join(extensionPath, 'media', 'searchBar.js'), 'utf8');
		// Rows are spliced in at the index the host sends, not appended in arrival order.
		assert.ok(client.includes('els.results.children[file.index]'), 'the client must insert rows by index');
		// Dismissing has to reach the host, or Replace All still rewrites the row.
		assert.ok(client.includes("type: 'dismiss'"), 'the client must tell the host about a dismissal');
		// The replacement text is debounced, so a replace action has to flush it first.
		assert.ok(
			/flushReplaceText\(\);\s*vscode\.postMessage\(\{\s*type:\s*'replaceAll'/.test(client),
			'a replace request must flush the pending replacement text',
		);
	});

	test('every declared control is in the markup and bound by the client', async () => {
		const client = await fs.readFile(path.join(extensionPath, 'media', 'searchBar.js'), 'utf8');
		for (const id of CONTROL_IDS) {
			assert.ok(fake.webview.html.includes(`id="${id}"`), `the markup is missing #${id}`);
			assert.ok(client.includes(`$('${id}')`), `the client script never looks up #${id}`);
		}
		// Replace All has no text of its own, so an unpopulated icon would leave a
		// blank button that looks broken rather than discrete.
		assert.ok(
			client.includes('els.replaceAll.appendChild(svgIcon('),
			'the client must give the Replace All button its icon',
		);
	});

	test('replacing a single match rewrites only that occurrence', async () => {
		const uri = await writeFile('tmp-one.txt', 'kiwi one\nkiwi two\n');
		const p = params({ query: 'kiwi', replaceText: 'plum' });
		const { files } = await search(p);
		const file = fileFor(files, uri);
		assert.strictEqual(file.matchCount, 2);

		const secondLine = file.lines.find((l: any) => l.line === 2);
		const finished = fake.nextMessage('replaceDone');
		fake.send({ type: 'replaceMatches', uri: file.uri, matches: secondLine.matches });
		const done = await finished;

		assert.match(done.message, /Replaced 1 occurrence/);
		const text = (await vscode.workspace.openTextDocument(uri)).getText();
		assert.strictEqual(text, 'kiwi one\nplum two\n');
	});

	test('replacing in a file rewrites every match in it', async () => {
		const uri = await writeFile('tmp-file.txt', 'mango a\nmango b\n');
		const { files } = await search(params({ query: 'mango', replaceText: 'melon' }));

		const finished = fake.nextMessage('replaceDone');
		fake.send({ type: 'replaceFile', uri: fileFor(files, uri).uri });
		await finished;

		assert.strictEqual((await vscode.workspace.openTextDocument(uri)).getText(), 'melon a\nmelon b\n');
	});

	test('a regex replacement expands its capture groups', async () => {
		const uri = await writeFile('tmp-regex.txt', 'papaya=17\n');
		const p = params({ query: '(papaya)=(\\d+)', isRegex: true, replaceText: '$2:$1' });
		const { files } = await search(p);

		const finished = fake.nextMessage('replaceDone');
		fake.send({ type: 'replaceFile', uri: fileFor(files, uri).uri });
		await finished;

		assert.strictEqual((await vscode.workspace.openTextDocument(uri)).getText(), '17:papaya\n');
	});

	test('the results refresh themselves after a replace', async () => {
		const uri = await writeFile('tmp-refresh.txt', 'lychee\n');
		const { files } = await search(params({ query: 'lychee', replaceText: 'guava' }));

		fake.clearPosted();
		const finished = fake.nextMessage('searchDone');
		fake.send({ type: 'replaceFile', uri: fileFor(files, uri).uri });
		const done = await finished;

		assert.strictEqual(done.matchCount, 0, 'the replaced text must no longer match');
	});

	test('a whole-word query flanked by punctuation replaces what was listed', async () => {
		// The results come from ripgrep, the replacement from a JavaScript RegExp:
		// for a whole-word query that does not start with a word character the two
		// used to pick *different* occurrences, so the replacement landed on text
		// that had never been shown as a match.
		const uri = await writeFile('tmp-word.txt', 'call (foo) now\nx-foo and -foo\n');
		const p = params({ query: '-foo', matchWholeWord: true, replaceText: 'Z' });
		const { done, files } = await search(p);
		assert.strictEqual(done.matchCount, 1, 'only the standalone -foo is a whole word');

		const finished = fake.nextMessage('replaceDone');
		fake.send({ type: 'replaceFile', uri: fileFor(files, uri).uri });
		assert.match((await finished).message, /Replaced 1 occurrence/);
		assert.strictEqual(
			(await vscode.workspace.openTextDocument(uri)).getText(),
			'call (foo) now\nx-foo and Z\n',
		);
	});

	test('a dismissed row is not replaced by a later Replace All', async () => {
		const uri = await writeFile('tmp-dismiss.txt', 'kiwi one\nkiwi two\n');
		const { files } = await search(params({ query: 'kiwi', replaceText: 'plum' }));
		const file = fileFor(files, uri);

		fake.send({ type: 'dismiss', uri: file.uri, line: 1 });
		const finished = fake.nextMessage('replaceDone');
		fake.send({ type: 'replaceFile', uri: file.uri });
		await finished;

		assert.strictEqual(
			(await vscode.workspace.openTextDocument(uri)).getText(),
			'kiwi one\nplum two\n',
			'the dismissed occurrence must be left alone',
		);
	});

	// --- Result order --------------------------------------------------------

	test('files are listed in path order, however the engine finds them', async () => {
		// Both backends report files as they finish them, and ripgrep searches in
		// parallel — so without sorting the same search lists the same files in a
		// different order nearly every run, and every automatic re-run reshuffles
		// the list under the cursor.
		for (const name of ['tmp-order-z.txt', 'tmp-order-a.txt', 'tmp-order-m.txt']) {
			await writeFile(name, 'orderable\n');
		}
		const p = params({ query: 'orderable' });
		const first = await search(p);
		assert.deepStrictEqual(listedOrder(first.files), [
			'tmp-order-a.txt',
			'tmp-order-m.txt',
			'tmp-order-z.txt',
		]);

		const second = await search(p);
		assert.deepStrictEqual(
			listedOrder(second.files),
			listedOrder(first.files),
			're-running the same search must produce the same list',
		);
	});

	// --- Stale results -------------------------------------------------------

	test('unsaved edits are searched, not the last saved version', async () => {
		const uri = await writeFile('tmp-dirty.txt', 'durian\n');
		assert.strictEqual((await search(params({ query: 'durian' }))).done.matchCount, 1);

		// Edit in memory only — exactly the state you are in mid-typing.
		const document = await vscode.workspace.openTextDocument(uri);
		const edit = new vscode.WorkspaceEdit();
		edit.insert(uri, new vscode.Position(0, 6), ' durian durian');
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual(document.isDirty, true, 'the document should be dirty, not saved');

		const after = await search(params({ query: 'durian' }));
		assert.strictEqual(after.done.matchCount, 3, 'the unsaved text must be what is searched');
		assert.strictEqual(after.done.fileCount, 1, 'the on-disk copy must not be reported as well');
	});

	test('text deleted but not yet saved stops matching', async () => {
		const uri = await writeFile('tmp-gone.txt', 'rambutan\n');
		assert.strictEqual((await search(params({ query: 'rambutan' }))).done.matchCount, 1);

		const document = await vscode.workspace.openTextDocument(uri);
		const edit = new vscode.WorkspaceEdit();
		edit.delete(uri, new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 8)));
		assert.ok(await vscode.workspace.applyEdit(edit));
		assert.strictEqual(document.isDirty, true);

		assert.strictEqual((await search(params({ query: 'rambutan' }))).done.matchCount, 0);
	});

	test('a change while the view is hidden is picked up when it is shown again', async () => {
		await writeFile('tmp-hidden.txt', 'starfruit\n');
		assert.strictEqual((await search(params({ query: 'starfruit' }))).done.matchCount, 1);

		fake.setVisible(false);
		fake.clearPosted();
		provider.onWorkspaceFilesChanged();
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.strictEqual(
			fake.messages('searchStarted').length,
			0,
			'a hidden view should not re-run searches, only remember that it must',
		);

		const finished = fake.nextMessage('searchDone');
		fake.setVisible(true);
		const done = await finished;
		assert.strictEqual(done.matchCount, 1, 'becoming visible must re-run the stale search');
	});

	test('an untouched, visible view does not re-run on its own', async () => {
		await writeFile('tmp-quiet.txt', 'quince\n');
		await search(params({ query: 'quince' }));
		fake.clearPosted();
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.strictEqual(fake.messages('searchStarted').length, 0);
	});

	// --- Result presentation -------------------------------------------------

	test('a match at the end of a long line is inside the rendered text', async () => {
		const filler = 'x'.repeat(400);
		const uri = await writeFile('tmp-long.txt', `${filler}tamarind\n`);
		const { files } = await search(params({ query: 'tamarind' }));

		const line = fileFor(files, uri).lines[0];
		const highlight = line.highlights[0];
		assert.ok(line.text.includes('tamarind'), 'the match must be part of what gets rendered');
		assert.strictEqual(line.text.slice(highlight.start, highlight.end), 'tamarind');
		assert.strictEqual(line.leadingElided, true, 'the skipped prefix must be flagged');
		assert.ok(line.text.length < 400, 'the line must be trimmed, not shipped whole');
	});

	test('leading indentation is dropped without shifting the highlight', async () => {
		const uri = await writeFile('tmp-indent.txt', '\t\t  jackfruit here\n');
		const { files } = await search(params({ query: 'jackfruit' }));

		const line = fileFor(files, uri).lines[0];
		assert.strictEqual(line.text, 'jackfruit here');
		assert.strictEqual(line.leadingElided, false);
		assert.strictEqual(line.text.slice(line.highlights[0].start, line.highlights[0].end), 'jackfruit');
		// The raw coordinates keep the indentation, so clicking still lands right.
		assert.strictEqual(line.matches[0].column, 4);
	});

	test('the replacement preview travels with each highlight', async () => {
		const uri = await writeFile('tmp-preview.txt', 'apricot\n');
		const { files } = await search(params({ query: 'apricot', replaceText: 'peach' }));

		const line = fileFor(files, uri).lines[0];
		assert.strictEqual(line.highlights[0].replacement, 'peach');
	});
});
