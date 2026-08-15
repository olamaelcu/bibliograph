/**
 * Lazy TSV helpers. The dump lines carry a large JSON payload in the final
 * field; these helpers let callers reach an early field (e.g. the OL key)
 * or check field counts without materialising the full split array, and only
 * fully split a line when a record actually needs processing.
 */

/** Extract the nth (0-based) field of a tab-separated line, or null when the line has no such field. */
export function tsvField(line: string, index: number): string | null {
	let start = 0;
	for (let i = 0; i < index; i++) {
		const tab = line.indexOf('\t', start);
		if (tab === -1) return null;
		start = tab + 1;
	}
	const end = line.indexOf('\t', start);
	return end === -1 ? line.slice(start) : line.slice(start, end);
}

/** Split a line into at most `limit` fields without scanning beyond the limit-th separator. */
export function splitTsv(line: string, limit: number): string[] {
	return line.split('\t', limit);
}

/** True when the line has at least `n` fields. Equivalent to `line.split('\t').length >= n`. */
export function hasMinFields(line: string, n: number): boolean {
	return tsvField(line, n - 1) !== null;
}
