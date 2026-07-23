import * as assert from 'assert';

import { buildLineRegExp, buildRipgrepArgs, escapeRegExp, matchLine, splitGlobs } from '../search/searchEngine';
import type { SearchParams } from '../core/types';

function params(partial: Partial<SearchParams> = {}): SearchParams {
	return {
		query: partial.query ?? 'needle',
		isRegex: partial.isRegex ?? false,
		isCaseSensitive: partial.isCaseSensitive ?? false,
		matchWholeWord: partial.matchWholeWord ?? false,
		replaceText: partial.replaceText ?? '',
		filesToInclude: partial.filesToInclude ?? '',
		filesToExclude: partial.filesToExclude ?? '',
	};
}

suite('searchEngine · helpers', () => {
	test('splitGlobs trims, splits on commas and drops empties', () => {
		assert.deepStrictEqual(splitGlobs('src/**/*.ts, **/*.js ,, '), ['src/**/*.ts', '**/*.js']);
		assert.deepStrictEqual(splitGlobs(''), []);
	});

	test('escapeRegExp escapes regex metacharacters', () => {
		assert.strictEqual(escapeRegExp('a.b*c(d)'), 'a\\.b\\*c\\(d\\)');
	});
});

suite('searchEngine · buildLineRegExp / matchLine', () => {
	test('literal query treats the text as non-regex', () => {
		const { regex } = buildLineRegExp(params({ query: 'a.b', isRegex: false }));
		assert.ok(regex);
		assert.deepStrictEqual(matchLine(regex!, 'a.b axb'), [{ column: 0, endColumn: 3 }]);
	});

	test('regex query is honoured', () => {
		const { regex } = buildLineRegExp(params({ query: 'a.b', isRegex: true }));
		assert.strictEqual(matchLine(regex!, 'axb').length, 1);
	});

	test('case sensitivity flag controls matching', () => {
		const insensitive = buildLineRegExp(params({ query: 'TODO', isCaseSensitive: false })).regex!;
		const sensitive = buildLineRegExp(params({ query: 'TODO', isCaseSensitive: true })).regex!;
		assert.strictEqual(matchLine(insensitive, 'a todo b').length, 1);
		assert.strictEqual(matchLine(sensitive, 'a todo b').length, 0);
	});

	test('whole-word flag anchors on word boundaries', () => {
		const regex = buildLineRegExp(params({ query: 'cat', matchWholeWord: true })).regex!;
		assert.strictEqual(matchLine(regex, 'the cat sat').length, 1);
		assert.strictEqual(matchLine(regex, 'concatenate').length, 0);
	});

	test('multiple matches on one line report distinct columns', () => {
		const regex = buildLineRegExp(params({ query: 'ab' })).regex!;
		assert.deepStrictEqual(matchLine(regex, 'ab_ab'), [
			{ column: 0, endColumn: 2 },
			{ column: 3, endColumn: 5 },
		]);
	});

	test('zero-width matches do not loop forever', () => {
		const regex = buildLineRegExp(params({ query: 'x*', isRegex: true })).regex!;
		// 'x*' can match empty; matchLine must skip empties and terminate.
		assert.deepStrictEqual(matchLine(regex, 'axxb'), [{ column: 1, endColumn: 3 }]);
	});

	test('invalid regex is reported, not thrown', () => {
		const result = buildLineRegExp(params({ query: '(', isRegex: true }));
		assert.strictEqual(result.regex, undefined);
		assert.ok(result.error);
	});
});

suite('searchEngine · buildRipgrepArgs', () => {
	test('encodes flags, globs, query and paths', () => {
		const args = buildRipgrepArgs(
			params({
				query: 'foo',
				isCaseSensitive: true,
				matchWholeWord: true,
				isRegex: false,
				filesToInclude: 'src/**/*.ts, *.js',
				filesToExclude: '**/node_modules/**',
			}),
			['/root'],
		);
		assert.ok(args.includes('--json'));
		assert.ok(args.includes('--case-sensitive'));
		assert.ok(args.includes('--word-regexp'));
		assert.ok(args.includes('--fixed-strings'));
		// Include globs are passed through; excludes are negated with '!'.
		assert.ok(args.includes('src/**/*.ts'));
		assert.ok(args.includes('!**/node_modules/**'));
		// Pattern and paths come after the '--' terminator, in order.
		const dashDash = args.indexOf('--');
		assert.notStrictEqual(dashDash, -1);
		assert.strictEqual(args[dashDash + 1], 'foo');
		assert.strictEqual(args[dashDash + 2], '/root');
	});

	test('uses --ignore-case when Match Case is off and omits --fixed-strings for regex', () => {
		const args = buildRipgrepArgs(params({ isCaseSensitive: false, isRegex: true }), ['/root']);
		assert.ok(args.includes('--ignore-case'));
		assert.ok(!args.includes('--case-sensitive'));
		assert.ok(!args.includes('--fixed-strings'));
	});
});
