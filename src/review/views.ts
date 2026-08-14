import { books, contributorRoles, contributors, genres, works } from '../db/schema.js';

export type ReviewEntityType = 'book' | 'work' | 'contributor' | 'genre' | 'contributorRole';

export const reviewEntityTypes: ReviewEntityType[] = ['book', 'work', 'contributor', 'genre', 'contributorRole'];

/** Maps entity type → lifecycle table (for direct updates). */
export const entityTable = {
	book: books,
	work: works,
	contributor: contributors,
	genre: genres,
	contributorRole: contributorRoles,
} as const;

export const entityViewName = {
	book: 'book_import_issues',
	work: 'work_import_issues',
	contributor: 'contributor_import_issues',
	genre: 'genre_import_issues',
	contributorRole: 'contributor_role_import_issues',
} as const;

export const entityLabel = {
	book: 'book',
	work: 'work',
	contributor: 'contributor',
	genre: 'genre',
	contributorRole: 'contributorRole',
} as const;
