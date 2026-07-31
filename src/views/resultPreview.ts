// Turns a raw matched line into the slice of text the results list should show.
//
// A result line is only useful if you can actually see the thing you searched
// for. Rendering the whole line and letting CSS clip it means a match near the
// end of a long line — a minified bundle, a long import list — is cut off and
// invisible. So the host computes a *window* around the first match: leading
// indentation is dropped, a bounded amount of context is kept before the match,
// and the rest is elided. The webview then only has to render what it is given.
//
// Pure and `vscode`-free so it can be unit-tested directly.

/** A `[start, end)` character range within the raw line. */
export type Range = readonly [number, number];

/** A highlight positioned within {@link PreviewWindow.text}. */
export interface PreviewHighlight {
	start: number;
	end: number;
	/** Index of the originating range in the input array, so callers can pair it back up. */
	index: number;
}

export interface PreviewWindow {
	/** The visible slice of the line. */
	text: string;
	highlights: PreviewHighlight[];
	/** Text was dropped before {@link text} (render a leading ellipsis). */
	leadingElided: boolean;
	/** Text was dropped after {@link text} (render a trailing ellipsis). */
	trailingElided: boolean;
}

export interface PreviewWindowOptions {
	/** Maximum number of characters to show. */
	maxLength?: number;
	/** Characters of context to keep in front of the first match when eliding. */
	leadContext?: number;
	/**
	 * Column `line` starts at, when the engine already sliced a very long line
	 * (see `previewSlice`). Ranges are always in document coordinates.
	 */
	offset?: number;
}

export const DEFAULT_MAX_LENGTH = 240;
export const DEFAULT_LEAD_CONTEXT = 20;

/**
 * Build the visible window for one matched line.
 *
 * The window always contains the start of the first match: if the match sits
 * further right than {@link PreviewWindowOptions.leadContext} characters into
 * the (indentation-trimmed) line, the prefix is dropped and `leadingElided` is
 * set. Ranges are clipped to the window and re-based onto {@link
 * PreviewWindow.text}; a range that falls entirely outside is dropped.
 */
export function buildPreviewWindow(
	line: string,
	ranges: readonly Range[],
	options: PreviewWindowOptions = {},
): PreviewWindow {
	const maxLength = options.maxLength ?? DEFAULT_MAX_LENGTH;
	const leadContext = options.leadContext ?? DEFAULT_LEAD_CONTEXT;
	const offset = options.offset ?? 0;

	// Leading indentation carries no information here, so it never costs window
	// budget — but it does shift every column, so keep the amount. Only a line
	// that really starts at column 0 has indentation to drop; on an engine slice
	// the leading spaces are ordinary content.
	const indent = offset === 0 ? line.length - line.trimStart().length : 0;
	const body = line.slice(indent);
	/** Document column that `body[0]` sits at. */
	const base = offset + indent;

	const firstStart = ranges.length === 0
		? 0
		: Math.max(0, Math.min(...ranges.map((r) => r[0])) - base);
	const start = firstStart > leadContext ? firstStart - leadContext : 0;
	const end = Math.min(body.length, start + maxLength);

	const highlights: PreviewHighlight[] = [];
	for (const [index, [rawStart, rawEnd]] of ranges.entries()) {
		const s = Math.max(start, rawStart - base);
		const e = Math.min(end, rawEnd - base);
		if (e > s) {
			highlights.push({ start: s - start, end: e - start, index });
		}
	}
	highlights.sort((a, b) => a.start - b.start);

	return {
		text: body.slice(start, end),
		highlights,
		// Text is missing in front either because this window skipped it or
		// because the engine's slice already did.
		leadingElided: start > 0 || offset > 0,
		trailingElided: end < body.length,
	};
}
