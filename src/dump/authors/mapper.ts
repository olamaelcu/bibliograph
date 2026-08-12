/**
 * Author-dump mapper.
 *
 * Maps raw OpenLibrary author-dump records (as emitted by the gzip streamer)
 * into the contributor row shape consumed by the upsert layer. Per design
 * decision we DO NOT capture birth_date, death_date, personal_name, or links —
 * only the fields the contributor table actually carries.
 */

export interface DumpAuthorRecord {
  key: string;
  type: string | { key: string };
  name?: string;
  alternate_names?: string[];
  bio?: string | { value: string };
  [k: string]: unknown;
}

export interface ContributorRecord {
  name: string;
  altNames: string[];
  bio?: string;
  identifiers: Array<{ type: string; value: string }>;
}

function extractTypeKey(type: unknown): string | null {
  if (typeof type === 'string') return type;
  if (type && typeof type === 'object' && typeof (type as { key?: unknown }).key === 'string') {
    return (type as { key: string }).key;
  }
  return null;
}

function extractBio(bio: unknown): string | undefined {
  if (typeof bio === 'string') return bio;
  if (bio && typeof bio === 'object' && typeof (bio as { value?: unknown }).value === 'string') {
    return (bio as { value: string }).value;
  }
  return undefined;
}

export function toContributorRecord(record: DumpAuthorRecord): ContributorRecord | null {
  if (!record || typeof record !== 'object') return null;
  if (typeof record.key !== 'string' || record.key.length === 0) return null;
  if (extractTypeKey(record.type) !== '/type/author') return null;
  if (typeof record.name !== 'string' || record.name.length === 0) return null;

  const altNames = Array.isArray(record.alternate_names)
    ? record.alternate_names.filter((s): s is string => typeof s === 'string')
    : [];

  return {
    name: record.name,
    altNames,
    bio: extractBio(record.bio),
    identifiers: [{ type: 'openlibrary', value: record.key }],
  };
}
