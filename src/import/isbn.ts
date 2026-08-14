/** Strip ISBN separators (hyphens, spaces, middle dots) before building an `isbn:` resource. */
export function normalizeIsbn(raw: string): string {
	return raw.replace(/[-·\s]/g, '');
}
