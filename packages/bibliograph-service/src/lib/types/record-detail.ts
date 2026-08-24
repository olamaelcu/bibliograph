export type Identifier = { uri: string; resource: string };
export type Contribution = { subject: { uri: string; cid: string }; role: string };

export type EditionValue = {
  $type: 'community.lexicon.book.edition';
  title: string; subtitle?: string; place?: string; publishedYear?: number;
  language?: string; coverImageUrl?: string; description?: string;
  contributors: Contribution[]; identifiers: Identifier[]; createdAt: string;
};
export type WorkValue = {
  $type: 'community.lexicon.book.work';
  title: string; subtitle?: string; originalLanguage?: string;
  firstPublishedYear?: number; subjects: string[]; description?: string;
  contributors: Contribution[]; identifiers: Identifier[]; createdAt: string;
};
export type ContributorValue = {
  $type: 'community.lexicon.book.contributor';
  name: string; aliases: string[]; bio?: string; bornYear?: number; diedYear?: number;
  linkedDid?: string; identifiers: Identifier[]; createdAt: string;
};
export type PublisherValue = {
  $type: 'community.lexicon.book.publisher';
  name: string; imprintOf?: { uri: string; cid: string }; foundingDate?: number;
  closingDate?: number; identifiers: Identifier[]; createdAt: string;
};

export type DetailValue = EditionValue | WorkValue | ContributorValue | PublisherValue;
export type DetailKind = 'editions' | 'works' | 'contributors' | 'publishers';

export type LoadResult =
  | { kind: DetailKind; rkey: string; notFound: true }
  | { kind: DetailKind; rkey: string; notFound: false; value: DetailValue };
