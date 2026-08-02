export interface TestBook {
  uri: string;
  did: string;
  title: string;
  author: string;
  isbn?: string;
  publishedDate?: string;
  description?: string;
  pageCount?: number;
  language?: string;
  categories?: string[];
  identifiers?: Array<{ type: string; value: string }>;
  coverUrl?: string;
  deduplicationHash?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

let _seq = 0;

export function makeBook(overrides: Partial<TestBook> = {}): TestBook {
  _seq++;
  const now = new Date().toISOString();
  const n = String(_seq).padStart(3, '0');
  const rkey = `test${n}${Math.random().toString(36).slice(2, 8)}`;
  return {
    uri: `at://did:plc:test/community.lexicon.book.book/${rkey}`,
    did: 'did:plc:test',
    title: `Test Book ${n}`,
    author: `Test Author ${n}`,
    isbn: `9781234567${String(_seq).padStart(3, '0')}`,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export function makeClaim(overrides: Record<string, unknown> = {}) {
  _seq++;
  const now = new Date().toISOString();
  const n = String(_seq).padStart(3, '0');
  const rkey = `claim${n}${Math.random().toString(36).slice(2, 8)}`;
  return {
    uri: `at://did:plc:test/community.lexicon.book.claim/${rkey}`,
    did: 'did:plc:test',
    bookUri: overrides.bookUri as string || `at://did:plc:test/community.lexicon.book.book/test001`,
    identifier: '9781234567890',
    identifierType: 'isbn',
    claimedBy: 'did:plc:test',
    status: 'pending',
    createdAt: now,
    ...overrides,
  };
}

export function makeReview(overrides: Record<string, unknown> = {}) {
  _seq++;
  const now = new Date().toISOString();
  const n = String(_seq).padStart(3, '0');
  const rkey = `review${n}${Math.random().toString(36).slice(2, 8)}`;
  return {
    uri: `at://did:plc:test/community.lexicon.book.review/${rkey}`,
    did: 'did:plc:test',
    bookUri: overrides.bookUri as string || `at://did:plc:test/community.lexicon.book.book/test001`,
    text: `Great book ${n}`,
    rating: 4,
    bookTitle: 'Test Book',
    bookAuthor: 'Test Author',
    createdAt: now,
    ...overrides,
  };
}

export function makeStatus(overrides: Record<string, unknown> = {}) {
  _seq++;
  const now = new Date().toISOString();
  const n = String(_seq).padStart(3, '0');
  const rkey = `status${n}${Math.random().toString(36).slice(2, 8)}`;
  return {
    uri: `at://did:plc:test/community.lexicon.book.status/${rkey}`,
    did: 'did:plc:test',
    bookUri: overrides.bookUri as string || `at://did:plc:test/community.lexicon.book.book/test001`,
    status: 'to-read',
    progress: undefined as number | undefined,
    rating: undefined as number | undefined,
    bookTitle: 'Test Book',
    bookAuthor: 'Test Author',
    identifiers: [] as Array<{ type: string; value: string }>,
    createdAt: now,
    ...overrides,
  };
}

export function makeLabel(overrides: Record<string, unknown> = {}) {
  const now = new Date().toISOString();
  return {
    src: 'did:web:localhost',
    uri: 'at://did:plc:test/community.lexicon.book.book/test001',
    val: 'book:author',
    cts: now,
    neg: 0,
    ...overrides,
  };
}
