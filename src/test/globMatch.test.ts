import * as assert from 'assert';

import { isInSearchScope, matchesAnyGlob, normalizeSearchGlob } from '../search/globMatch';

suite('globMatch · normalizeSearchGlob', () => {
	test('a bare name targets the file anywhere in the tree', () => {
		assert.deepStrictEqual(normalizeSearchGlob('*.ts'), ['**/*.ts']);
	});

	test('a directory name also covers everything below it', () => {
		assert.deepStrictEqual(normalizeSearchGlob('src'), ['**/src', '**/src/**']);
		assert.deepStrictEqual(normalizeSearchGlob('src/utils'), ['src/utils', 'src/utils/**']);
	});

	test('leading ./ and trailing / are normalized away', () => {
		assert.deepStrictEqual(normalizeSearchGlob('./src/'), ['**/src', '**/src/**']);
	});

	test('a wildcard pattern is not also treated as a directory', () => {
		assert.deepStrictEqual(normalizeSearchGlob('src/**/*.ts'), ['src/**/*.ts']);
	});

	test('a wildcard path ending in a plain name still covers its contents', () => {
		// This is how the default `files.exclude` entry `**/node_modules` manages
		// to exclude the files inside the folder and not just the folder itself.
		assert.deepStrictEqual(normalizeSearchGlob('**/node_modules'), ['**/node_modules', '**/node_modules/**']);
	});

	test('blank patterns expand to nothing', () => {
		assert.deepStrictEqual(normalizeSearchGlob('   '), []);
	});
});

suite('globMatch · matchesAnyGlob', () => {
	test('* does not cross directory separators', () => {
		assert.strictEqual(matchesAnyGlob(['src/*.ts'], 'src/a.ts'), true);
		assert.strictEqual(matchesAnyGlob(['src/*.ts'], 'src/deep/a.ts'), false);
	});

	test('** spans any number of directories, including none', () => {
		assert.strictEqual(matchesAnyGlob(['src/**/*.ts'], 'src/a.ts'), true);
		assert.strictEqual(matchesAnyGlob(['src/**/*.ts'], 'src/a/b/c.ts'), true);
	});

	test('brace alternatives and ? are supported', () => {
		assert.strictEqual(matchesAnyGlob(['**/*.{ts,tsx}'], 'a/b.tsx'), true);
		assert.strictEqual(matchesAnyGlob(['**/*.{ts,tsx}'], 'a/b.js'), false);
		assert.strictEqual(matchesAnyGlob(['a?.ts'], 'ab.ts'), true);
	});

	test('dots are literal, not wildcards', () => {
		assert.strictEqual(matchesAnyGlob(['**/*.ts'], 'axts'), false);
	});

	test('backslash separators are matched like forward slashes', () => {
		assert.strictEqual(matchesAnyGlob(['src/**/*.ts'], 'src\\deep\\a.ts'), true);
	});
});

suite('globMatch · isInSearchScope', () => {
	test('no includes means everything is in scope', () => {
		assert.strictEqual(isInSearchScope('any/file.md', [], []), true);
	});

	test('includes narrow, excludes veto', () => {
		assert.strictEqual(isInSearchScope('src/a.ts', ['*.ts'], []), true);
		assert.strictEqual(isInSearchScope('src/a.md', ['*.ts'], []), false);
		assert.strictEqual(isInSearchScope('src/a.ts', ['*.ts'], ['**/src/**']), false);
	});

	test('an excluded dependency folder stays out of scope', () => {
		assert.strictEqual(isInSearchScope('node_modules/pkg/index.js', [], ['**/node_modules']), false);
	});
});
