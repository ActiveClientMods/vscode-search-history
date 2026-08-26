// The order files appear in the in-view results list.
//
// Both backends report files in whatever order they finish reading them, and
// ripgrep searches in parallel — so the *same* search run twice returns the same
// files in a different order almost every time. Every automatic re-run (an edit,
// a file event, a replace) therefore reshuffled the whole list, and a row you
// were about to click moved out from under you even though nothing about it had
// changed.
//
// Sorting by path fixes that: the list is a stable, alphabetical function of the
// matches, so a re-run only changes the rows whose matches actually changed.
// It also matches VS Code's own Search view, which lists files in path order.
//
// Pure and `vscode`-free so it can be unit-tested directly.

/** Files are inserted as they stream in, so all this needs is a path. */
export interface PathOrdered {
	relativePath: string;
}

const SEPARATOR = /[/\\]/;

/**
 * Compare like a file explorer: case-insensitively, digit runs by value (so
 * `item2` precedes `item10`), and with a file in a directory ahead of that
 * directory's subfolders. Purely alphabetical differences aside, the tiebreak on
 * raw text keeps the order total — two paths differing only in case must not
 * compare equal, or their relative order would be arbitrary again.
 */
export function compareResultPaths(a: string, b: string): number {
	const left = a.split(SEPARATOR);
	const right = b.split(SEPARATOR);
	const shared = Math.min(left.length, right.length);
	for (let i = 0; i < shared; i++) {
		// One path ends at this segment while the other keeps descending: the file
		// sitting directly in the folder comes before the folder's contents.
		const leftEnds = i === left.length - 1;
		const rightEnds = i === right.length - 1;
		if (leftEnds !== rightEnds) {
			return leftEnds ? -1 : 1;
		}
		const byName = collator().compare(left[i], right[i]);
		if (byName !== 0) {
			return byName;
		}
		if (left[i] !== right[i]) {
			return left[i] < right[i] ? -1 : 1;
		}
	}
	return 0;
}

/**
 * Insert `file` into an already-sorted list, returning the index it landed at —
 * which is also the position the webview has to splice its row into, so the two
 * stay in step without duplicating the comparison there.
 */
export function insertByPath<T extends PathOrdered>(files: T[], file: T): number {
	let low = 0;
	let high = files.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (compareResultPaths(files[mid].relativePath, file.relativePath) <= 0) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	files.splice(low, 0, file);
	return low;
}

let cached: Intl.Collator | undefined;

function collator(): Intl.Collator {
	cached ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
	return cached;
}
