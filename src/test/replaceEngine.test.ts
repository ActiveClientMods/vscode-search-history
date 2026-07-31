import * as assert from 'assert';

import type { SearchParams } from '../core/types';
import {
	describeReplacement,
	expandReplacement,
	planReplacements,
	selectReplacements,
} from '../search/replaceEngine';

function params(partial: Partial<SearchParams> = {}): SearchParams {
	return {
		query: partial.query ?? 'needle',
		isRegex: partial.isRegex ?? false,
		isCaseSensitive: partial.isCaseSensitive ?? false,
		matchWholeWord: partial.matchWholeWord ?? false,
		replaceText: partial.replaceText ?? 'thread',
		filesToInclude: partial.filesToInclude ?? '',
		filesToExclude: partial.filesToExclude ?? '',
	};
}

/** The lines as they would read after applying the plan. */
function applied(lines: string[], p: SearchParams): string[] {
	const { plan, error } = planReplacements(lines, p);
	assert.strictEqual(error, undefined);
	const out = [...lines];
	// Right to left, so earlier columns are not shifted by earlier edits.
	for (const item of plan.toReversed()) {
		const line = out[item.line - 1];
		out[item.line - 1] = line.slice(0, item.column) + item.replacement + line.slice(item.endColumn);
	}
	return out;
}

suite('replaceEngine · expandReplacement', () => {
	const exec = (pattern: string, text: string): RegExpExecArray => {
		const match = new RegExp(pattern).exec(text);
		assert.ok(match, `pattern ${pattern} should match ${text}`);
		return match;
	};

	test('literal mode inserts the template verbatim', () => {
		assert.strictEqual(expandReplacement(exec('foo', 'foo'), '$1 & $&', false), '$1 & $&');
	});

	test('regex mode expands numbered groups', () => {
		assert.strictEqual(expandReplacement(exec('(\\w+)-(\\w+)', 'a-b'), '$2_$1', true), 'b_a');
	});

	test('regex mode expands $& and $$', () => {
		assert.strictEqual(expandReplacement(exec('ab', 'ab'), '[$&]', true), '[ab]');
		assert.strictEqual(expandReplacement(exec('ab', 'ab'), '$$', true), '$');
	});

	test('regex mode expands named groups', () => {
		assert.strictEqual(expandReplacement(exec('(?<word>\\w+)', 'hi'), '<$<word>>', true), '<hi>');
	});

	test('a group the pattern does not have is left as typed', () => {
		assert.strictEqual(expandReplacement(exec('ab', 'ab'), '$7', true), '$7');
	});

	test('backslash escapes become real characters in regex mode', () => {
		assert.strictEqual(expandReplacement(exec('ab', 'ab'), 'x\\ty\\nz', true), 'x\ty\nz');
	});
});

suite('replaceEngine · planReplacements', () => {
	test('plans one replacement per literal occurrence', () => {
		const { plan } = planReplacements(['needle here', 'no match', 'needle needle'], params());
		assert.strictEqual(plan.length, 3);
		assert.deepStrictEqual(
			plan.map((p) => [p.line, p.column, p.endColumn]),
			[[1, 0, 6], [3, 0, 6], [3, 7, 13]],
		);
		assert.ok(plan.every((p) => p.text === 'needle' && p.replacement === 'thread'));
	});

	test('literal queries are not treated as patterns', () => {
		assert.deepStrictEqual(applied(['a.b axb'], params({ query: 'a.b', replaceText: 'Z' })), ['Z axb']);
	});

	test('regex captures are substituted', () => {
		assert.deepStrictEqual(
			applied(['const foo = 1;'], params({ query: '(\\w+) = (\\d+)', isRegex: true, replaceText: '$2 = $1' })),
			['const 1 = foo;'],
		);
	});

	test('case sensitivity is honoured', () => {
		assert.deepStrictEqual(
			applied(['Needle needle'], params({ query: 'needle', isCaseSensitive: true, replaceText: 'X' })),
			['Needle X'],
		);
		assert.deepStrictEqual(
			applied(['Needle needle'], params({ query: 'needle', isCaseSensitive: false, replaceText: 'X' })),
			['X X'],
		);
	});

	test('whole-word matching is honoured', () => {
		assert.deepStrictEqual(
			applied(['cat concatenate cat'], params({ query: 'cat', matchWholeWord: true, replaceText: 'dog' })),
			['dog concatenate dog'],
		);
	});

	test('an empty replacement deletes the match', () => {
		assert.deepStrictEqual(applied(['a needle b'], params({ replaceText: '' })), ['a  b']);
	});

	test('an invalid regex is reported instead of throwing', () => {
		const { plan, error } = planReplacements(['anything'], params({ query: '(', isRegex: true }));
		assert.deepStrictEqual(plan, []);
		assert.ok(error);
	});

	test('a query with no matches plans nothing', () => {
		assert.deepStrictEqual(planReplacements(['nothing here'], params()).plan, []);
	});
});

suite('replaceEngine · selectReplacements', () => {
	const { plan } = planReplacements(['needle needle', 'needle'], params());

	test('no selection means every occurrence', () => {
		assert.strictEqual(selectReplacements(plan, undefined).length, 3);
	});

	test('a selection picks out exactly the requested occurrences', () => {
		const selected = selectReplacements(plan, [{ line: 1, column: 7 }]);
		assert.deepStrictEqual(selected.map((p) => [p.line, p.column]), [[1, 7]]);
	});

	test('a stale location selects nothing rather than the wrong text', () => {
		assert.deepStrictEqual(selectReplacements(plan, [{ line: 9, column: 4 }]), []);
	});
});

suite('replaceEngine · describeReplacement', () => {
	test('reads naturally for one and many', () => {
		assert.strictEqual(describeReplacement(1, 1), '1 occurrence');
		assert.strictEqual(describeReplacement(2, 5), '5 occurrences across 2 files');
	});
});
