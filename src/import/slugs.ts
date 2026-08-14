/** Slugify a source key into a stable, URL-safe PK. */
export function sourceKeySlug(key: string): string {
	const cleaned = key
		.replace(/^\/+/, '')
		.replace(/[^a-zA-Z0-9._/-]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.toLowerCase();
	if (!cleaned) throw new Error(`cannot derive slug from source key: ${key}`);
	return cleaned;
}

export const olKey = {
	book: (key: string) => sourceKeySlug(key), // /books/OL123M -> books/ol123m
	work: (key: string) => sourceKeySlug(key),
	author: (key: string) => sourceKeySlug(key),
};

/** Namespaced identifier resource strings, e.g. openlibrary:OL123M */
export function identifierResource(ns: string, value: string): string {
	return `${ns}:${value}`;
}
