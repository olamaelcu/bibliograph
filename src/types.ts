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
  status: 'pending' | 'active' | 'rejected';
  createdAt: string;
  updatedAt: string;
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
  createdAt: string;
}

// Status record
export interface StatusRecord {
  $type: 'community.lexicon.book.status';
  bookUri: string;
  status: 'reading' | 'read' | 'to-read' | 'abandoned';
  progress?: number; // 0-100
  rating?: number; // 1-5
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
}

// XRPC input/output types
export interface GetBookParams { uri: string; }
export interface GetBookOutput { uri: string; record: unknown; cid?: string; }

export interface GetBooksParams { uris: string[]; }
export interface GetBooksOutput { books: Array<{ uri: string; record: unknown; cid?: string }>; }

export interface GetReviewsParams { bookUri: string; cursor?: string; limit?: number; }
export interface GetReviewsOutput { reviews: Array<{ uri: string; did: string; record: unknown }>; cursor?: string; }

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

export interface CreateStatusInput { bookUri: string; status: 'reading' | 'read' | 'to-read' | 'abandoned'; progress?: number; rating?: number; startedAt?: string; finishedAt?: string; }
export interface CreateStatusOutput { uri: string; cid: string; }

export interface CreateClaimInput { bookUri: string; identifier: string; identifierType: 'isbn' | 'ean' | 'issn'; }
export interface CreateClaimOutput { uri: string; cid: string; }
