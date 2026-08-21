export const COLLECTION = {
	book: 'net.olamaelcu.livtet.biblio.book',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	contributorRole: 'net.olamaelcu.livtet.biblio.contributorRole',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
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
