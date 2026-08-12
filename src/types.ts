// Book record
export interface BookRecord {
  $type: 'community.lexicon.book.book';
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
  contributors?: BookContributorEntry[];
  status: 'pending' | 'active' | 'rejected';
  createdAt: string;
  updatedAt: string;
}

// Book reference (copy-over-reference model)
export interface BookRef {
  uri: string;
  title: string;
  author: string;
  isbn?: string;
  publishedDate?: string;
  deduplicationHash?: string;
  identifiers?: Array<{ type: string; value: string }>;
}

// Claim record
export interface ClaimRecord {
  $type: 'community.lexicon.book.claim';
  bookUri: string;
  isbn?: string;
  identifier: string;
  identifierType: 'isbn' | 'ean' | 'issn';
  claimedBy: string;
  status: 'pending' | 'verified' | 'rejected';
  verifiedBy?: string;
  verifiedAt?: string;
  createdAt: string;
}

// Review record
export interface ReviewRecord {
  $type: 'community.lexicon.book.review';
  bookUri: string;
  text: string;
  rating?: number; // 1-5
  bookRef: BookRef;
  createdAt: string;
}

// Status record
export interface StatusRecord {
  $type: 'community.lexicon.book.status';
  bookUri: string;
  status: 'reading' | 'read' | 'to-read' | 'abandoned' | 'wishlist';
  progress?: number;
  rating?: number;
  bookRef: BookRef;
  identifiers?: Array<{ type: string; value: string }>;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

// Shelf record
export interface ShelfRecord {
  $type: 'community.lexicon.book.shelf';
  name: string;
  description?: string;
  metadata?: unknown;
  coverUrl?: string;
  createdAt: string;
}

// Shelf item record (membership)
export interface ShelfItemRecord {
  $type: 'community.lexicon.book.shelfItem';
  shelfUri: string;
  bookUri: string;
  bookRef: BookRef;
  note?: string;
  createdAt: string;
}

// Contributor record
export interface ContributorImageRef {
  url: string;
  alt?: string;
}

export interface ContributorRecord {
  $type: 'community.lexicon.book.contributor';
  name: string; // max 200
  altNames?: string[];
  images?: ContributorImageRef[];
  identifiers?: Array<{ type: string; value: string }>; // min 1 enforced at runtime
  bio?: string; // max 16384
  createdAt: string;
}

// Contributor type record
export interface ContributorTypeRecord {
  $type: 'community.lexicon.book.contributor.type';
  name: string; // max 256
  description?: string; // max 16384
  createdAt: string;
}

// Strong ref to a record (uri + cid)
export interface StrongRef {
  uri: string;
  cid: string;
}

// Inline contributor reference on a book record (strongRef + optional order)
export interface BookContributorEntry {
  contributor: StrongRef;
  role: StrongRef;
  order?: number;
}

// Joined contributor response (with embedded record for convenience)
export interface BookContributorJoined {
  contributor: { uri: string; cid: string; did: string; record: ContributorRecord };
  role: { uri: string; cid: string; did: string; record: ContributorTypeRecord };
  order?: number;
}

// XRPC input/output types
export interface GetBookParams { uri: string; }
export interface GetBookOutput { uri: string; record: unknown; cid?: string; }

export interface GetBooksParams { uris: string[]; }
export interface GetBooksOutput { books: Array<{ uri: string; record: unknown; cid?: string }>; }

export interface GetReviewsParams { bookUri: string; cursor?: string; limit?: number; }
export interface GetReviewsOutput { reviews: Array<{ uri: string; did: string; record: unknown }>; cursor?: string; }

export interface GetReviewParams { uri?: string; did?: string; bookUri?: string; }
export interface GetReviewOutput { uri: string; did: string; record: unknown; cid?: string; }

export interface GetUserStatusParams { did: string; bookUri?: string; status?: string; cursor?: string; limit?: number; }
export interface GetUserStatusOutput { statuses: Array<{ uri: string; did: string; bookUri: string; record: unknown }>; cursor?: string; }

export interface SearchBooksParams { q: string; limit?: number; cursor?: string; }
export interface SearchBooksOutput { books: Array<{ uri: string; record: unknown }>; cursor?: string; total?: number; }

export interface GetClaimsParams { bookUri: string; }
export interface GetClaimsOutput { claims: Array<{ uri: string; did: string; record: unknown }>; }

export interface CreateBookInput { title: string; author: string; isbn?: string; publishedDate?: string; description?: string; pageCount?: number; language?: string; categories?: string[]; coverUrl?: string; }
export interface CreateBookOutput { uri: string; cid: string; }

export interface CreateReviewInput { bookUri: string; text: string; rating?: number; }
export interface CreateReviewOutput { uri: string; cid: string; }

export interface CreateStatusInput { bookUri?: string; identifiers?: Array<{ type: string; value: string }>; status: 'reading' | 'read' | 'to-read' | 'abandoned' | 'wishlist'; progress?: number; rating?: number; startedAt?: string; finishedAt?: string; }
export interface CreateStatusOutput { uri: string; cid: string; }

export interface CreateClaimInput { bookUri: string; identifier: string; identifierType: 'isbn' | 'ean' | 'issn'; }
export interface CreateClaimOutput { uri: string; cid: string; }

export interface GetShelvesParams { did: string; cursor?: string; limit?: number; }
export interface GetShelvesOutput { shelves: Array<{ uri: string; did: string; record: unknown }>; cursor?: string; }

export interface GetShelfParams { uri: string; }
export interface GetShelfOutput { uri: string; did: string; record: unknown; }

export interface GetShelfItemsParams { shelfUri: string; cursor?: string; limit?: number; }
export interface GetShelfItemsOutput { items: Array<{ uri: string; did: string; record: unknown }>; cursor?: string; }

export interface CreateShelfInput { name: string; description?: string; metadata?: unknown; coverUrl?: string; }
export interface CreateShelfOutput { uri: string; cid: string; }

export interface AddToShelfInput { shelfUri: string; bookUri: string; note?: string; }
export interface AddToShelfOutput { uri: string; cid: string; }

export interface RemoveFromShelfInput { shelfUri: string; bookUri: string; }
export interface RemoveFromShelfOutput { ok: boolean; }

// Contributor I/O
export interface CreateContributorInput {
  name: string;
  altNames?: string[];
  images?: ContributorImageRef[];
  identifiers: Array<{ type: string; value: string }>;
  bio?: string;
}
export interface CreateContributorOutput { uri: string; cid: string; }

export interface UpdateContributorPatch {
  name?: string;
  altNames?: string[];
  bio?: string;
}
export interface UpdateContributorInput {
  uri: string;
  patch?: UpdateContributorPatch;
  addIdentifiers?: Array<{ type: string; value: string }>;
  removeIdentifiers?: Array<{ type: string; value: string }>;
  addImages?: ContributorImageRef[];
  removeImages?: Array<{ url: string }>;
}
export interface UpdateContributorOutput { uri: string; cid: string; }

export interface CreateContributorTypeInput {
  name: string;
  description?: string;
}
export interface CreateContributorTypeOutput { uri: string; cid: string; }

export interface GetContributorParams { uri: string; }
export interface GetContributorOutput { uri: string; did: string; record: ContributorRecord; cid?: string; }

export interface ListContributorsParams { limit?: number; cursor?: string; }
export interface ListContributorsOutput {
  contributors: Array<{ uri: string; did: string; record: ContributorRecord }>;
  cursor?: string;
  total?: number;
}

export interface SearchContributorsParams { q: string; limit?: number; cursor?: string; }
export interface SearchContributorsOutput {
  contributors: Array<{ uri: string; did: string; record: ContributorRecord }>;
  cursor?: string;
  total?: number;
}

export interface ListContributorTypesParams { limit?: number; cursor?: string; }
export interface ListContributorTypesOutput {
  types: Array<{ uri: string; did: string; record: ContributorTypeRecord }>;
  cursor?: string;
  total?: number;
}

// Feed generator
export type FeedWindow = 'day' | 'week' | 'month';
export type FeedRecentType = 'review' | 'status';

export interface FeedRecentItem {
  type: FeedRecentType;
  did: string;
  uri: string;
  book: BookRef;
  createdAt: string;
}

export interface GetFeedParams { limit?: number; cursor?: string; }
export interface GetFeedOutput {
  recent: FeedRecentItem[];
  newestBooks: BookRef[];
  trending: Record<FeedWindow, BookRef[]>;
  following?: BookRef[];
  crossUser?: Record<FeedWindow, BookRef[]>;
  degraded?: boolean;
  cursor?: string;
}
