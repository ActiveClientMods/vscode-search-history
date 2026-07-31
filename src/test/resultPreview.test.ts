import * as assert from 'assert';

import { buildPreviewWindow, type Range } from '../views/resultPreview';

/** The text the webview would actually render, ellipses included. */
function rendered(line: string, ranges: Range[], options?: Parameters<typeof buildPreviewWindow>[2]): string {
	const window = buildPreviewWindow(line, ranges, options);
	return (window.leadingElided ? '…' : '') + window.text + (window.trailingElided ? '…' : '');
}

/** The substrings the highlights cover — must always equal the matched text. */
function highlighted(line: string, ranges: Range[], options?: Parameters<typeof buildPreviewWindow>[2]): string[] {
	const window = buildPreviewWindow(line, ranges, options);
	return window.highlights.map((h) => window.text.slice(h.start, h.end));
}

suite('resultPreview · buildPreviewWindow', () => {
	test('short lines are shown whole, minus indentation', () => {
		const line = '    const needle = 1;';
		const window = buildPreviewWindow(line, [[10, 16]]);
		assert.strictEqual(window.text, 'const needle = 1;');
		assert.strictEqual(window.leadingElided, false);
		assert.strictEqual(window.trailingElided, false);
		assert.deepStrictEqual(window.highlights, [{ start: 6, end: 12, index: 0 }]);
	});

	// The bug this guards: a match far to the right used to be rendered but
	// clipped by CSS, so the result row showed a line with nothing visibly in it.
	test('a match far to the right stays inside the window', () => {
		const line = `${'x'.repeat(300)}needle${'y'.repeat(300)}`;
		const window = buildPreviewWindow(line, [[300, 306]]);
		assert.ok(window.text.includes('needle'), 'the match must be part of the rendered text');
		assert.ok(window.leadingElided && window.trailingElided);
		// It sits at the configured amount of context in, not 300 characters in.
		assert.strictEqual(window.highlights[0].start, 20);
		assert.strictEqual(highlighted(line, [[300, 306]])[0], 'needle');
	});

	test('highlight offsets survive both indentation and elision', () => {
		const line = `\t\t${'a'.repeat(100)}TARGET tail`;
		const window = buildPreviewWindow(line, [[102, 108]], { leadContext: 5 });
		assert.strictEqual(window.text.slice(window.highlights[0].start, window.highlights[0].end), 'TARGET');
		assert.strictEqual(window.text.slice(0, 5), 'aaaaa');
	});

	test('a long tail is cut and flagged, never silently dropped', () => {
		const line = `needle${'z'.repeat(500)}`;
		const window = buildPreviewWindow(line, [[0, 6]], { maxLength: 50 });
		assert.strictEqual(window.text.length, 50);
		assert.strictEqual(window.trailingElided, true);
		assert.strictEqual(window.leadingElided, false);
	});

	test('every match on the line keeps its own highlight', () => {
		const line = 'ab cd ab';
		assert.deepStrictEqual(highlighted(line, [[0, 2], [6, 8]]), ['ab', 'ab']);
	});

	test('matches outside the window are dropped, not mis-positioned', () => {
		const line = `hit${'-'.repeat(400)}hit`;
		const window = buildPreviewWindow(line, [[0, 3], [403, 406]], { maxLength: 40 });
		assert.strictEqual(window.highlights.length, 1);
		assert.strictEqual(window.highlights[0].index, 0);
	});

	test('a line with no ranges is still rendered from the start', () => {
		assert.strictEqual(rendered('  plain text', []), 'plain text');
	});

	test('an engine-sliced line keeps its document coordinates', () => {
		// The engine cut a huge line down to `slice`, which starts at column 900.
		const slice = 'aaaaaNEEDLEbbbbb';
		const window = buildPreviewWindow(slice, [[905, 911]], { offset: 900, leadContext: 3 });
		assert.strictEqual(window.text.slice(window.highlights[0].start, window.highlights[0].end), 'NEEDLE');
		assert.strictEqual(window.leadingElided, true, 'the engine already dropped text in front');
	});

	test('an engine-sliced line does not lose leading spaces as indentation', () => {
		const window = buildPreviewWindow('   hit', [[503, 506]], { offset: 500 });
		assert.strictEqual(window.text, '   hit');
		assert.strictEqual(window.text.slice(window.highlights[0].start, window.highlights[0].end), 'hit');
	});

	test('the window is anchored on the first match, not the last', () => {
		const line = `${'q'.repeat(100)}one${'q'.repeat(100)}two`;
		const window = buildPreviewWindow(line, [[100, 103], [203, 206]], { leadContext: 10, maxLength: 60 });
		assert.strictEqual(window.text.slice(10, 13), 'one');
	});
});
