/** Types shared by the admin server routes and the browser-side curation UI. */

export const PROVIDERS = ['googlebooks', 'isbndb', 'goodreads', 'openlibrary'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Identifier = { issuer: string; value: string };

export type CandidateContributor = {
  name: string;
  role?: string;
  identifiers?: Identifier[];
  ref?: string;
};

export type CandidatePublisher = {
  name: string;
  identifiers?: Identifier[];
};

export type CandidateSeries = {
  name: string;
  position?: string;
  display?: string;
};

export type Candidate = {
  identifiers: Identifier[];
  title: string;
  contributors?: CandidateContributor[];
  publisher?: CandidatePublisher;
  subtitle?: string;
  language?: string;
  publishedDate?: string;
  format?: string;
  pages?: number;
  durationSeconds?: number;
  chapters?: number;
  series?: CandidateSeries;
  bookEdition?: string;
  description?: string;
  coverUrl?: string;
};

export type ProviderSearchResponse = {
  provider: Provider;
  candidates: Candidate[];
};

/** A read-only OpenLibrary contributor candidate; no roles (those are edition credits). */
export type ContributorCandidate = {
  displayName: string;
  nameInverted?: string;
  description?: string;
  imageUrl?: string;
  born?: string;
  died?: string;
  identifiers: Identifier[];
  key?: string;
};

export type ContributorSearchResponse = {
  query: string;
  limit: number;
  contributors: ContributorCandidate[];
};

export type IngestResponse = {
  uri: string;
  created: boolean;
};

export type PublisherSearchResponse = {
  query: string;
  publishers: string[];
  total: number;
  page: number;
  pageSize: number;
};

export type PublisherBooksResponse = {
  name: string;
  candidates: Candidate[];
  total: number;
  page: number;
  pageSize: number;
};

/** Why a bulk publisher import stopped early. */
export type PublisherImportStop = 'end' | 'max_pages' | 'quota_exhausted';

export type PublisherImportFailure = { title: string; message: string };

export type PublisherImportResponse = {
  name: string;
  pagesFetched: number;
  nextPage: number | null;
  total: number;
  imported: number;
  created: number;
  existing: number;
  failed: number;
  failures: PublisherImportFailure[];
  stopped: PublisherImportStop;
};

export type AdminContributor = {
  id: number;
  name: string;
  role: string;
  identifiers: Identifier[];
  ref: string | null;
};

export type AdminPublisher = {
  id: number;
  name: string;
  identifiers: Identifier[];
};

export type AdminSeries = {
  name: string;
  position?: string;
  display?: string;
};

export type AdminEdition = {
  uri: string;
  rkey: string;
  title: string;
  subtitle: string | null;
  language: string | null;
  publishedDate: string | null;
  format: string | null;
  pages: number | null;
  durationSeconds: number | null;
  chapters: number | null;
  series: AdminSeries | null;
  bookEdition: string | null;
  description: string | null;
  coverUrl: string | null;
  createdAt: string;
  indexedAt: string;
  updatedAt: string;
  identifiers: Identifier[];
  contributors: AdminContributor[];
  publishers: AdminPublisher[];
};

export type MergeField =
  | 'title'
  | 'subtitle'
  | 'language'
  | 'publishedDate'
  | 'format'
  | 'pages'
  | 'durationSeconds'
  | 'chapters'
  | 'series'
  | 'bookEdition'
  | 'description'
  | 'coverUrl';

export const MERGE_FIELDS: ReadonlyArray<{ key: MergeField; label: string }> = [
  { key: 'title', label: 'Title' },
  { key: 'subtitle', label: 'Subtitle' },
  { key: 'language', label: 'Language' },
  { key: 'publishedDate', label: 'Published date' },
  { key: 'format', label: 'Format' },
  { key: 'pages', label: 'Pages' },
  { key: 'durationSeconds', label: 'Duration (seconds)' },
  { key: 'chapters', label: 'Chapters' },
  { key: 'series', label: 'Series' },
  { key: 'bookEdition', label: 'Book edition' },
  { key: 'description', label: 'Description' },
  { key: 'coverUrl', label: 'Cover URL' }
];

export type LinkMode = 'source' | 'union';

export type MergeRequest = {
  base: string;
  others: string[];
  sources: Partial<Record<MergeField, string>>;
  contributors: { mode: LinkMode; source?: string };
  publishers: { mode: LinkMode; source?: string };
};

export type MergeResponse = {
  uri: string;
  deleted: string[];
  identifiers: number;
  contributors: number;
  publishers: number;
};

export function identifierText(identifier: Identifier): string {
  return `${identifier.issuer}:${identifier.value}`;
}
