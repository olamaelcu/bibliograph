import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import {
	authors,
	authorIdentifiers,
	bookContributors,
	bookGenres,
	bookIdentifiers,
	bookShelves,
	books,
	contributorRoles,
	formats,
	genreIdentifiers,
	genres,
	reviews,
	reviewTags,
	shelves,
	workIdentifiers,
	works,
} from '../db/schema.js';

export const SERVICE_DID = 'did:web:books.example.com';
export const SERVICE_HOST = 'books.example.com';

const COLLECTION = {
	book: 'net.olamaelcu.livtet.biblio.book',
	work: 'net.olamaelcu.livtet.biblio.work',
	contributor: 'net.olamaelcu.livtet.biblio.contributor',
	contributorRole: 'net.olamaelcu.livtet.biblio.contributorRole',
	format: 'net.olamaelcu.livtet.biblio.format',
	genre: 'net.olamaelcu.livtet.biblio.genre',
	review: 'net.olamaelcu.livtet.biblio.review',
	shelf: 'net.olamaelcu.livtet.biblio.shelf',
	bookShelf: 'net.olamaelcu.livtet.biblio.bookShelving',
} as const;

export function uri(collection: string, pk: string): string {
	return `at://${SERVICE_DID}/${collection}/${pk}`;
}

export interface TestDb {
	db: ReturnType<typeof drizzle>;
	sqlite: Database.Database;
	seed: () => void;
}

export function createTestDb(): TestDb {
	const sqlite = new Database(':memory:');
	const db = drizzle(sqlite);
	migrate(db, { migrationsFolder: 'drizzle' });
	return { db, sqlite, seed: () => seed(db) };
}

function seed(db: ReturnType<typeof drizzle>) {
	const now = Math.floor(Date.now() / 1000);

	const formatRows = [
		{ pk: 'paperback', description: 'Paperback', emoji: '📖', iconImageUrl: 'https://cdn.example.com/fmt-paperback.png', unit: 'pages' },
		{ pk: 'ebook', description: 'E-book', emoji: '📱', iconImageUrl: null, unit: 'percent' },
	];
	const genreRows = [
		{ pk: 'fiction', name: 'Fiction', description: 'Imaginary narratives', emoji: '📚', iconImageUrl: null, parentPk: null, createdAt: now },
		{ pk: 'scifi', name: 'Science Fiction', description: 'Speculative futures', emoji: '🚀', iconImageUrl: null, parentPk: 'fiction', createdAt: now },
	];
	const roleRows = [
		{ pk: 'author', name: 'Author', description: 'Wrote the book', iconImageUrl: null, createdAt: now },
		{ pk: 'translator', name: 'Translator', description: 'Translated the book', iconImageUrl: null, createdAt: now },
	];
	const workRows = [
		{ pk: 'work-dune', title: 'Dune', description: 'A desert planet saga', originalPublishDate: 1119484800, createdAt: now, updatedAt: null },
	];
	const authorRows = [
		{ pk: 'author-herbert', name: 'Frank Herbert', sortName: 'Herbert, Frank', bio: 'American author', imageUrl: null, createdAt: now, updatedAt: null },
		{ pk: 'author-algernon', name: 'Daniel Keyes', sortName: 'Keyes, Daniel', bio: 'American writer', imageUrl: null, createdAt: now, updatedAt: null },
	];
	const bookRows = [
		{ pk: 'book-dune', title: 'Dune (40th Anniversary)', workPk: 'work-dune', formatPk: 'paperback', publishDate: 1119484800, description: 'The classic', coverUrl: 'https://cdn.example.com/dune.jpg', createdAt: now, updatedAt: null },
		{ pk: 'book-flowers', title: 'Flowers for Algernon', workPk: null, formatPk: 'ebook', publishDate: 1119484800, description: 'A touching story', coverUrl: null, createdAt: now, updatedAt: null },
	];
	const shelfRows = [
		{ pk: 'shelf-favorites', name: 'Favorites', description: 'Books I loved', iconImageCid: null, headerImageCid: null, createdAt: now, updatedAt: null },
	];
	const reviewRows = [
		{ pk: 'review-1', bookPk: 'book-dune', did: 'did:plc:reader1', rating: 5, status: 'read', text: 'A masterpiece of worldbuilding', progressFormatPk: 'paperback', progressValue: 412, createdAt: now, updatedAt: null },
		{ pk: 'review-2', bookPk: 'book-flowers', did: 'did:plc:reader2', rating: 4, status: 'reading', text: 'Heartbreaking so far', progressFormatPk: null, progressValue: null, createdAt: now, updatedAt: null },
	];
	const bookShelfRows = [
		{ pk: 'shelving-1', did: 'did:plc:reader1', bookPk: 'book-dune', shelfPk: 'shelf-favorites', position: 1, notes: 'Rereading this winter', emoji: '🐛', status: 'reading', createdAt: now, updatedAt: null },
		{ pk: 'shelving-2', did: 'did:plc:reader2', bookPk: 'book-flowers', shelfPk: 'shelf-favorites', position: null, notes: null, emoji: null, status: 'to-read', createdAt: now, updatedAt: null },
	];

	db.insert(formats).values(formatRows).run();
	db.insert(genres).values(genreRows).run();
	db.insert(contributorRoles).values(roleRows).run();
	db.insert(works).values(workRows).run();
	db.insert(authors).values(authorRows).run();
	db.insert(books).values(bookRows).run();
	db.insert(shelves).values(shelfRows).run();
	db.insert(reviews).values(reviewRows).run();
	db.insert(bookShelves).values(bookShelfRows).run();

	db.insert(bookGenres).values([
		{ bookPk: 'book-dune', genrePk: 'fiction' },
		{ bookPk: 'book-dune', genrePk: 'scifi' },
	]).run();
	db.insert(bookContributors).values([
		{ bookPk: 'book-dune', contributorPk: 'author-herbert', rolePk: 'author', createdAt: now },
		{ bookPk: 'book-flowers', contributorPk: 'author-algernon', rolePk: 'author', createdAt: now },
	]).run();
	db.insert(bookIdentifiers).values([
		{ bookPk: 'book-dune', resource: 'isbn:0441172717', url: 'https://isbn.example.com/0441172717' },
	]).run();
	db.insert(workIdentifiers).values([
		{ workPk: 'work-dune', resource: 'openlibrary:OL893423W', url: 'https://openlibrary.example.com/OL893423W' },
	]).run();
	db.insert(authorIdentifiers).values([
		{ authorPk: 'author-herbert', resource: 'viaf:59083797', url: 'https://viaf.example.com/59083797' },
	]).run();
	db.insert(genreIdentifiers).values([
		{ genrePk: 'scifi', resource: 'babelio:science-fiction', url: 'https://babelio.example.com/science-fiction' },
	]).run();
	db.insert(reviewTags).values([
		{ reviewPk: 'review-1', tag: 'favorite', createdAt: now },
		{ reviewPk: 'review-1', tag: 'worldbuilding', createdAt: now },
	]).run();
}

export { COLLECTION };
