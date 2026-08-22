/**
 * AppView type definitions for `community.lexicon.book.*` and the
 * app-private shelf/bookShelving/actor namespaces. These mirror the
 * shape returned by AppView queries (`*View` types in the lex schema)
 * but are defined here as plain TypeScript so we can construct them
 * from DB rows without depending on the lex-cli's generated types.
 *
 * Kept loose to avoid coupling view shape to the lex-cli output.
 */

export interface Identifier {
	uri: string;
	resource: string;
}

export interface ContributorView {
	uri: string;
	name: string;
	role?: string;
	sortName?: string;
	bio?: string;
	identifiers: Identifier[];
	createdAt?: string;
	updatedAt?: string;
}

export interface EditionView {
	uri: string;
	title: string;
	subtitle?: string;
	publishedYear?: number;
	language?: string;
	place?: string;
	contributors: ContributorView[];
	identifiers: Identifier[];
	description?: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface ActorView {
	did: string;
	displayName?: string;
	description?: string;
	bsky?: { likeCount: number; quoteCount: number };
}

export interface ShelfView {
	uri: string;
	name: string;
	description?: string;
	createdAt?: string;
	updatedAt?: string;
	bsky?: { likeCount: number; quoteCount: number };
}

export interface BookShelfMetadata {
	status: 'reading' | 'to-read' | 'dnf' | 'read';
	position?: number;
	notes?: string;
	emoji?: string;
}

export interface BookShelfView {
	uri: string;
	shelf: ShelfView;
	book: EditionView;
	metadata: BookShelfMetadata;
	did: string;
	createdAt?: string;
	updatedAt?: string;
}

export interface ShelfWithBooksView {
	shelf: ShelfView;
	books: BookShelfView[];
}