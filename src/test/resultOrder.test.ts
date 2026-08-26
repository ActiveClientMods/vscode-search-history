import * as assert from 'assert';

import { compareResultPaths, insertByPath } from '../search/resultOrder';

/** Sort a list of paths the way the results list orders its files. */
function ordered(paths: string[]): string[] {
	return paths.toSorted(compareResultPaths);
}

suite('resultOrder · compareResultPaths', () => {
	test('sorts alphabetically', () => {
		assert.deepStrictEqual(ordered(['c.ts', 'a.ts', 'b.ts']), ['a.ts', 'b.ts', 'c.ts']);
	});

	test('ignores case', () => {
		assert.deepStrictEqual(ordered(['beta.ts', 'Alpha.ts', 'gamma.ts']), ['Alpha.ts', 'beta.ts', 'gamma.ts']);
	});

	test('orders digit runs by value, not by character', () => {
		assert.deepStrictEqual(ordered(['item10.ts', 'item2.ts', 'item1.ts']), ['item1.ts', 'item2.ts', 'item10.ts']);
	});

	test('compares directory by directory', () => {
		assert.deepStrictEqual(
			ordered(['src/views/a.ts', 'src/core/z.ts', 'media/b.css']),
			['media/b.css', 'src/core/z.ts', 'src/views/a.ts'],
		);
	});

	test('a file in a folder comes before that folder’s subfolders', () => {
		assert.deepStrictEqual(ordered(['src/zoo/a.ts', 'src/index.ts']), ['src/index.ts', 'src/zoo/a.ts']);
	});

	test('treats both path separators alike', () => {
		assert.strictEqual(compareResultPaths('src\\core\\a.ts', 'src/core/a.ts'), 0);
	});

	test('is a total order, so case-only differences never compare equal', () => {
		assert.notStrictEqual(compareResultPaths('README.md', 'readme.md'), 0);
	});

	test('is antisymmetric', () => {
		const paths = ['src/a.ts', 'src/A.ts', 'src/b/a.ts', 'a.ts', 'src2/a.ts'];
		for (const a of paths) {
			for (const b of paths) {
				assert.strictEqual(
					Math.sign(compareResultPaths(a, b)) + Math.sign(compareResultPaths(b, a)),
					0,
					`${a} vs ${b}`,
				);
			}
		}
	});
});

suite('resultOrder · insertByPath', () => {
	test('keeps the list sorted whatever order files arrive in', () => {
		// The order ripgrep finishes files in is arbitrary — this is the point of
		// the exercise: the same set of files must always end up listed the same way.
		const arrivals = ['src/z.ts', 'a.ts', 'src/b.ts', 'media/x.css'];
		const files: { relativePath: string }[] = [];
		for (const relativePath of arrivals) {
			insertByPath(files, { relativePath });
		}
		assert.deepStrictEqual(
			files.map((f) => f.relativePath),
			['a.ts', 'media/x.css', 'src/b.ts', 'src/z.ts'],
		);
	});

	test('returns the index the file landed at', () => {
		const files: { relativePath: string }[] = [];
		assert.strictEqual(insertByPath(files, { relativePath: 'b.ts' }), 0);
		assert.strictEqual(insertByPath(files, { relativePath: 'd.ts' }), 1);
		assert.strictEqual(insertByPath(files, { relativePath: 'a.ts' }), 0);
		assert.strictEqual(insertByPath(files, { relativePath: 'c.ts' }), 2);
		assert.deepStrictEqual(files.map((f) => f.relativePath), ['a.ts', 'b.ts', 'c.ts', 'd.ts']);
	});

	test('duplicate paths keep their arrival order', () => {
		const files: { relativePath: string; id: number }[] = [];
		insertByPath(files, { relativePath: 'a.ts', id: 1 });
		insertByPath(files, { relativePath: 'a.ts', id: 2 });
		assert.deepStrictEqual(files.map((f) => f.id), [1, 2]);
	});
});
