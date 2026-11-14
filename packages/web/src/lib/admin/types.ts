/** Types shared by the admin server routes and the browser-side curation UI. */

export const PROVIDERS = ['googlebooks', 'isbndb', 'goodreads', 'openlibrary'] as const;
export type Provider = (typeof PROVIDERS)[number];

export type Identifier = { issuer: string; value: string };

export type CandidateContributor = {
  name: string;
  /** Provider-supplied inverted form ("Le Guin, Ursula K."), kept for the record. */
  nameInverted?: string;
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
  /** Opaque content revision; the editor sends it back to detect concurrent edits. */
  revision: string;
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

/** One local contributor or publisher returned by the editor's picker. */
export type AdminEntityMatch = {
  id: number;
  name: string;
  identifiers: Identifier[];
  ref: string | null;
};

export type AdminEntitySearchResponse = {
  type: 'contributor' | 'publisher';
  query: string;
  items: AdminEntityMatch[];
};

/**
 * A contributor row as the dedicated admin editor reads it. `atUri` is the
 * canonical at-URI stored on the row (null until `entities.prepare` mints it),
 * and `revision` is the optimistic concurrency token the editor echoes back.
 */
export type AdminContributorRecord = {
  id: number;
  atUri: string | null;
  name: string;
  nameInverted: string | null;
  identifiers: Identifier[];
  description: string | null;
  imageUrl: string | null;
  born: string | null;
  died: string | null;
  createdAt: string;
  revision: string;
};

export type AdminPublisherRecord = {
  id: number;
  atUri: string | null;
  name: string;
  identifiers: Identifier[];
  description: string | null;
  imageUrl: string | null;
  started: string | null;
  ended: string | null;
  createdAt: string;
  revision: string;
};

export type ContributorEditResponse = { contributor: AdminContributorRecord };

export type PublisherEditResponse = { publisher: AdminPublisherRecord };

/** Fields a contributor merge can take from the absorbed row. */
export type ContributorMergeField =
  | 'description'
  | 'nameInverted'
  | 'imageUrl'
  | 'born'
  | 'died';

/** What one contributor merge does, computed before and after the write. */
export type ContributorMergePlan = {
  /** Edition credits repointed from the absorbed row to the survivor. */
  moved: number;
  /** Credits dropped because the survivor already holds that role there. */
  dropped: number;
  /** Identifier pairs the survivor did not already carry. */
  identifiersAdded: number;
  /** Fields taken from the absorbed row because the survivor's are blank. */
  fields: ContributorMergeField[];
};

export type ContributorMergePreview = {
  source: AdminContributorRecord;
  target: AdminContributorRecord;
  plan: ContributorMergePlan;
};

export type ContributorMergeResponse = {
  target: AdminContributorRecord;
  absorbedId: number;
  absorbedAtUri: string | null;
  plan: ContributorMergePlan;
};

export type EditionEditResponse = { edition: AdminEdition };

/** Goodreads returns the free-text format it uses on the edition page. */
export type ResolveFormatResponse = {
  isbn: string;
  format: string;
  source: 'goodreads';
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

// ── Reports ─────────────────────────────────────────────────────────────────
//
// Shared by the admin reporting API and the Reports tab. The registry is
// authored server-side in `$lib/server/admin/reports.ts`; these types only
// describe the JSON the browser receives. Every row is JSON-safe (dates are
// ISO strings) and an edition row's `uri` is its canonical stored at-URI.

export type ReportColumnFormat =
  | 'at-uri'
  | 'edition-list'
  | 'text'
  | 'number'
  | 'date'
  | 'status';

export type ReportColumn = {
  key: string;
  label: string;
  format: ReportColumnFormat;
};

export type ReportParamOption = { value: string; label: string };

export type ReportParamSpec = {
  key: string;
  label: string;
  kind: 'text' | 'select';
  defaultValue: string;
  placeholder?: string;
  options?: ReportParamOption[];
};

export type ReportKind =
  | 'editions'
  | 'contributors'
  | 'publishers'
  | 'identifier-pairs'
  | 'outbox';

export type ReportSummary = {
  id: string;
  title: string;
  description: string;
  kind: ReportKind;
  columns: ReportColumn[];
  params: ReportParamSpec[];
};

export type ReportRow = Record<string, unknown>;

export type ReportRegistryResponse = { reports: ReportSummary[] };

export type ReportResponse = {
  report: ReportSummary;
  /** The filters the server applied, echoed as submitted. */
  params: Record<string, string | number>;
  rows: ReportRow[];
  /** Full match count for the report, not just this page. */
  total: number;
  limit: number;
  offset: number;
};
