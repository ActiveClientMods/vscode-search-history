import * as assert from 'assert';

import { PREVIEW_LIMIT, previewSlice } from '../search/engineCore';

suite('engineCore · previewSlice', () => {
	test('a normal line is passed through untouched', () => {
		assert.deepStrictEqual(previewSlice('const a = 1;', 6), { text: 'const a = 1;', start: 0 });
	});

	test('the trailing newline is stripped', () => {
		assert.strictEqual(previewSlice('value\r\n', 0).text, 'value');
	});

	// The regression: a long line used to be cut from the left at a fixed limit,
	// which threw away every match sitting past it.
	test('a long line is cut around the match, not from the left', () => {
		const line = `${'x'.repeat(5000)}NEEDLE${'y'.repeat(5000)}`;
		const slice = previewSlice(line, 5000);
		assert.ok(slice.start > 0, 'the slice must start near the match');
		assert.ok(slice.text.includes('NEEDLE'), 'the match must survive the cut');
		assert.strictEqual(slice.text.length, PREVIEW_LIMIT);
		// `start` has to describe the slice exactly, or every column would be off.
		assert.strictEqual(line.slice(slice.start, slice.start + slice.text.length), slice.text);
	});

	test('a match at the very end of a long line is still included', () => {
		const line = `${'x'.repeat(5000)}TAIL`;
		const slice = previewSlice(line, 5000);
		assert.ok(slice.text.endsWith('TAIL'));
	});
});
