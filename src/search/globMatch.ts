// A small, dependency-free matcher for the include/exclude globs typed into the
// search bar.
//
// The engines themselves delegate glob filtering to ripgrep (`--glob`) or to
// `workspace.findFiles`, so this exists for the one case neither can cover: the
// unsaved-document overlay (see `searchEngine.ts`), which scans open editors
// whose in-memory text differs from disk and therefore has to decide by itself
// whether a given file is inside the user's include/exclude scope.
//
// It implements the subset of VS Code's search-glob semantics that matters:
// `*`, `?`, `**`, `{a,b}` and `[abc]`, plus the two implicit rules — a pattern
// without a slash matches the file name anywhere in the tree (`*.ts` →
// `**/*.ts`), and a pattern naming a directory also matches everything below it
// (`src/utils` → `src/utils/**`).

/** Expand one user-typed pattern into the concrete globs it should match. */
export function normalizeSearchGlob(pattern: string): string[] {
	const trimmed = pattern.trim().replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
	if (trimmed === '') {
		return [];
	}
	// "*.ts" has no separator, so it targets a file name anywhere in the tree.
	const base = trimmed.includes('/') ? trimmed : `**/${trimmed}`;
	const globs = [base];
	// A pattern ending in a plain name may be a directory, and naming a directory
	// means everything underneath it — how `**/node_modules` in the default
	// `files.exclude` manages to exclude the files inside it, not just the folder.
	const lastSegment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
	if (!/[*?[\]{}]/.test(lastSegment)) {
		globs.push(`${base}/**`);
	}
	return globs;
}

/** Translate a single glob into an anchored regular expression. */
export function globToRegExp(glob: string): RegExp {
	let source = '';
	let braceDepth = 0;
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === '*') {
			if (glob[i + 1] === '*') {
				i += 1;
				if (glob[i + 1] === '/') {
					i += 1;
					source += '(?:[^/]*/)*'; // "**/" spans zero or more directories
				} else {
					source += '.*';
				}
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') {
			source += '[^/]';
		} else if (char === '{') {
			braceDepth += 1;
			source += '(?:';
		} else if (char === '}' && braceDepth > 0) {
			braceDepth -= 1;
			source += ')';
		} else if (char === ',' && braceDepth > 0) {
			source += '|';
		} else if (char === '[') {
			const close = glob.indexOf(']', i + 1);
			if (close === -1) {
				source += '\\[';
			} else {
				const body = glob.slice(i + 1, close);
				source += `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`;
				i = close;
			}
		} else {
			source += char.replace(/[.+^${}()|[\]\\]/, '\\$&');
		}
	}
	return new RegExp(`^${source}$`);
}

const cache = new Map<string, RegExp[]>();

function compile(pattern: string): RegExp[] {
	let compiled = cache.get(pattern);
	if (!compiled) {
		compiled = normalizeSearchGlob(pattern).map(globToRegExp);
		cache.set(pattern, compiled);
	}
	return compiled;
}

/** True when `relativePath` matches at least one of the patterns. */
export function matchesAnyGlob(patterns: readonly string[], relativePath: string): boolean {
	const path = relativePath.replaceAll('\\', '/');
	return patterns.some((pattern) => compile(pattern).some((re) => re.test(path)));
}

/**
 * Apply search include/exclude scoping to one path: an empty include list means
 * "everything", and any exclude match wins.
 */
export function isInSearchScope(
	relativePath: string,
	includes: readonly string[],
	excludes: readonly string[],
): boolean {
	if (includes.length > 0 && !matchesAnyGlob(includes, relativePath)) {
		return false;
	}
	return !matchesAnyGlob(excludes, relativePath);
}
