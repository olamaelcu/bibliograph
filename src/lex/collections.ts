/**
 * Canonical collection NSIDs. Catalog records live under the community
 * `community.lexicon.book.*` namespace; user-owned records (shelves,
 * book shelvings, actor profiles) stay app-private under
 * `net.olamaelcu.livtet.biblio.*`.
 */
export const COLLECTION = {
	edition: 'community.lexicon.book.edition',
	contributor: 'community.lexicon.book.contributor',
	// App-private user-owned collections (Jetstream-indexed):
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelf',
	actor: 'net.olamaelcu.livtet.biblio.actor',
} as const;

export interface ViewContext {
	serviceDid: string;
}

export interface PdsRecord {
	uri: string;
	cid: string;
	value: unknown;
}