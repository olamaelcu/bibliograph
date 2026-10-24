// Bibliograph's label vocabulary.
//
// Label values are a per-labeler namespace: `controversial` from us is not
// Bluesky's. Each value needs a declared behavior so clients can render it —
// `blurs` decides what is hidden, `severity` decides the tone of the banner, and
// `defaultSetting` decides what a fresh subscriber sees before configuring.
//
// This is the single source of truth for our values. It is intentionally shaped
// like `com.atproto.label.defs#labelValueDefinition` so it can be published in
// an `app.bsky.labeler.service/self` record without translation.

export type LabelSeverity = 'alert' | 'inform' | 'none';
export type LabelBlurs = 'content' | 'media' | 'none';
export type LabelDefaultSetting = 'hide' | 'warn' | 'ignore';

export interface LabelDefinition {
  identifier: string;
  severity: LabelSeverity;
  blurs: LabelBlurs;
  defaultSetting: LabelDefaultSetting;
  adultOnly: boolean;
  /** What the label can be attached to. `account` = bare DID, `record` = at:// URI. */
  subjects: Array<'account' | 'record'>;
  locales: Array<{ lang: string; name: string; description: string }>;
}

/**
 * Label values, with the reasoning that drives their behavior:
 *
 * - `librarian` / `administrator` / `senior-librarian` are account-level
 *   credentials. They must never blur content (they say nothing about the
 *   subject's content), so `blurs: none`, and `severity: inform` gives a neutral
 *   badge rather than a warning.
 * - `controversial` is record-level and informational: the book is not unsafe,
 *   it is widely challenged or banned. `defaultSetting: warn` surfaces the banner
 *   by default, because the whole point is that a reader sees the context.
 */
export const LABEL_DEFINITIONS = {
  librarian: {
    identifier: 'librarian',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'ignore',
    adultOnly: false,
    subjects: ['account'],
    locales: [
      {
        lang: 'en',
        name: 'Librarian',
        description: 'May vote on how editions, works, contributors, and publishers are linked.',
      },
    ],
  },
  'senior-librarian': {
    identifier: 'senior-librarian',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'ignore',
    adultOnly: false,
    subjects: ['account'],
    locales: [
      {
        lang: 'en',
        name: 'Senior librarian',
        description: 'Has curated the catalog for over a year and contributed regularly.',
      },
    ],
  },
  administrator: {
    identifier: 'administrator',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'ignore',
    adultOnly: false,
    subjects: ['account'],
    locales: [
      {
        lang: 'en',
        name: 'Administrator',
        description: 'Reviews librarian applications and can label catalog records.',
      },
    ],
  },
  controversial: {
    identifier: 'controversial',
    severity: 'inform',
    blurs: 'none',
    defaultSetting: 'warn',
    adultOnly: false,
    subjects: ['record'],
    locales: [
      {
        lang: 'en',
        name: 'Controversial',
        description: 'This title is frequently challenged, restricted, or banned.',
      },
    ],
  },
} as const satisfies Record<string, LabelDefinition>;

export type LabelIdentifier = keyof typeof LABEL_DEFINITIONS;

export const LIBRARIAN_LABEL: LabelIdentifier = 'librarian';
export const SENIOR_LIBRARIAN_LABEL: LabelIdentifier = 'senior-librarian';
export const ADMINISTRATOR_LABEL: LabelIdentifier = 'administrator';
export const CONTROVERSIAL_LABEL: LabelIdentifier = 'controversial';

/** Every value we may emit. Used to reject typos before signing anything. */
export const KNOWN_LABELS: readonly LabelIdentifier[] = Object.keys(LABEL_DEFINITIONS) as LabelIdentifier[];

export function isKnownLabel(value: string): value is LabelIdentifier {
  return (KNOWN_LABELS as readonly string[]).includes(value);
}

/**
 * Enforce the declared subject kind: an account label must target a bare DID and
 * a record label an `at://` URI. Cheap guard against mislabelling a DID as a
 * record, which would make the label unfindable by clients.
 */
export function subjectMatches(identifier: LabelIdentifier, uri: string): boolean {
  const subjects: readonly string[] = LABEL_DEFINITIONS[identifier].subjects;
  const isAccount = uri.startsWith('did:');
  return isAccount ? subjects.includes('account') : subjects.includes('record');
}
