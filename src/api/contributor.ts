import type { Context } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db, schema } from '../db/connection.js';
import { requireAuth, isLibrarian } from '../auth.js';
import {
  COLLECTIONS,
  insertContributor,
  insertContributorType,
  makeRecordUri,
  makeId,
  findContributorByIdentifier,
  findContributorByUri,
  findContributorTypeByName,
  type ContributorImage,
} from '../records.js';
import type {
  CreateContributorInput,
  UpdateContributorInput,
  CreateContributorTypeInput,
  ContributorRecord,
  ContributorTypeRecord,
} from '../types.js';

const { contributors, contributorTypes } = schema;

const NAME_MAX = 200;
const BIO_MAX = 16384;
const TYPE_NAME_MAX = 256;
const TYPE_DESC_MAX = 16384;

function identifiersEqual(
  a: { type: string; value: string },
  b: { type: string; value: string },
): boolean {
  return a.type === b.type && a.value === b.value;
}

function parseIdentifierArray(value: unknown): Array<{ type: string; value: string }> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<{ type: string; value: string }> = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.type !== 'string' || typeof obj.value !== 'string') return null;
    if (!obj.type || !obj.value) return null;
    out.push({ type: obj.type, value: obj.value });
  }
  return out;
}

function parseImageArray(value: unknown): ContributorImage[] | null {
  if (!Array.isArray(value)) return null;
  const out: ContributorImage[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const obj = entry as Record<string, unknown>;
    if (typeof obj.url !== 'string' || !obj.url) return null;
    const image: ContributorImage = { url: obj.url };
    if (typeof obj.alt === 'string') image.alt = obj.alt;
    out.push(image);
  }
  return out;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    out.push(entry);
  }
  return out;
}

function serializeContributor(row: typeof contributors.$inferSelect): ContributorRecord {
  const record: ContributorRecord = {
    $type: 'community.lexicon.book.contributor',
    name: row.name,
    createdAt: row.createdAt,
  };
  if (Array.isArray(row.altNames) && row.altNames.length > 0) record.altNames = row.altNames;
  if (Array.isArray(row.images) && row.images.length > 0) record.images = row.images;
  if (Array.isArray(row.identifiers) && row.identifiers.length > 0) {
    record.identifiers = row.identifiers;
  }
  if (row.bio) record.bio = row.bio;
  return record;
}

function serializeContributorType(row: typeof contributorTypes.$inferSelect): ContributorTypeRecord {
  const record: ContributorTypeRecord = {
    $type: 'community.lexicon.book.contributor.type',
    name: row.name,
    createdAt: row.createdAt,
  };
  if (row.description) record.description = row.description;
  return record;
}

export async function createContributor(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(
    c.req.raw.headers,
    'community.lexicon.book.contributor.create',
  );
  const input = await c.req.json<CreateContributorInput>();

  if (!input.name || typeof input.name !== 'string') {
    log.warn({ did }, 'createContributor rejected: missing name');
    return c.json({ error: 'InvalidInput', message: 'name is required' }, 400);
  }
  if (input.name.length > NAME_MAX) {
    log.warn({ did, len: input.name.length }, 'createContributor rejected: name too long');
    return c.json({ error: 'InvalidInput', message: `name must be ${NAME_MAX} characters or fewer` }, 400);
  }

  const identifiers = parseIdentifierArray(input.identifiers);
  if (!identifiers || identifiers.length === 0) {
    log.warn({ did }, 'createContributor rejected: missing identifiers');
    return c.json(
      { error: 'InvalidInput', message: 'identifiers must contain at least one entry with non-empty type and value' },
      400,
    );
  }

  let altNames: string[] | undefined;
  if (input.altNames !== undefined) {
    const parsed = parseStringArray(input.altNames);
    if (!parsed) {
      return c.json({ error: 'InvalidInput', message: 'altNames must be an array of strings' }, 400);
    }
    altNames = parsed;
  }

  let images: ContributorImage[] | undefined;
  if (input.images !== undefined) {
    const parsed = parseImageArray(input.images);
    if (!parsed) {
      return c.json({ error: 'InvalidInput', message: 'images must be an array of { url, alt? }' }, 400);
    }
    images = parsed;
  }

  if (input.bio !== undefined && input.bio.length > BIO_MAX) {
    log.warn({ did, len: input.bio.length }, 'createContributor rejected: bio too long');
    return c.json({ error: 'InvalidInput', message: `bio must be ${BIO_MAX} characters or fewer` }, 400);
  }

  for (const ident of identifiers) {
    const dup = await findContributorByIdentifier(db, ident.type, ident.value);
    if (dup) {
      log.warn({ did, ident, existingUri: dup.uri }, 'createContributor rejected: duplicate identifier');
      return c.json(
        {
          error: 'DuplicateContributor',
          message: `A contributor with identifier (${ident.type}, ${ident.value}) already exists`,
          existingUri: dup.uri,
        },
        409,
      );
    }
  }

  log.info({ did, name: input.name, identCount: identifiers.length }, 'handling createContributor');

  const { uri, rkey } = await insertContributor(db, {
    did,
    name: input.name,
    altNames: altNames ?? [],
    images: images ?? [],
    identifiers,
    bio: input.bio,
  });

  log.info({ uri }, 'createContributor complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export async function updateContributor(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(
    c.req.raw.headers,
    'community.lexicon.book.contributor.update',
  );
  const input = await c.req.json<UpdateContributorInput>();

  if (!input.uri) {
    log.warn({ did }, 'updateContributor rejected: missing uri');
    return c.json({ error: 'InvalidInput', message: 'uri is required' }, 400);
  }

  log.info({ did, uri: input.uri }, 'handling updateContributor');

  const existing = await findContributorByUri(db, input.uri);
  if (!existing) {
    log.warn({ did, uri: input.uri }, 'updateContributor rejected: not found');
    return c.json({ error: 'NotFound', message: 'Contributor not found' }, 404);
  }

  if (existing.did !== did && !isLibrarian(did)) {
    log.warn({ did, owner: existing.did, uri: input.uri }, 'updateContributor rejected: forbidden');
    return c.json(
      { error: 'Forbidden', message: 'Only the creator or a librarian can update this contributor' },
      403,
    );
  }

  const next: {
    name: string;
    altNames: string[];
    images: ContributorImage[];
    identifiers: Array<{ type: string; value: string }>;
    bio: string | null;
  } = {
    name: existing.name,
    altNames: Array.isArray(existing.altNames) ? [...existing.altNames] : [],
    images: Array.isArray(existing.images) ? [...existing.images] : [],
    identifiers: Array.isArray(existing.identifiers) ? [...existing.identifiers] : [],
    bio: existing.bio ?? null,
  };

  if (input.patch) {
    if (input.patch.name !== undefined) {
      if (typeof input.patch.name !== 'string' || !input.patch.name) {
        return c.json({ error: 'InvalidInput', message: 'patch.name must be a non-empty string' }, 400);
      }
      if (input.patch.name.length > NAME_MAX) {
        return c.json({ error: 'InvalidInput', message: `name must be ${NAME_MAX} characters or fewer` }, 400);
      }
      next.name = input.patch.name;
    }
    if (input.patch.altNames !== undefined) {
      const parsed = parseStringArray(input.patch.altNames);
      if (!parsed) {
        return c.json({ error: 'InvalidInput', message: 'patch.altNames must be an array of strings' }, 400);
      }
      next.altNames = parsed;
    }
    if (input.patch.bio !== undefined) {
      if (typeof input.patch.bio !== 'string') {
        return c.json({ error: 'InvalidInput', message: 'patch.bio must be a string' }, 400);
      }
      if (input.patch.bio.length > BIO_MAX) {
        return c.json({ error: 'InvalidInput', message: `bio must be ${BIO_MAX} characters or fewer` }, 400);
      }
      next.bio = input.patch.bio;
    }
  }

  if (input.addImages) {
    const parsed = parseImageArray(input.addImages);
    if (!parsed) {
      return c.json({ error: 'InvalidInput', message: 'addImages must be an array of { url, alt? }' }, 400);
    }
    const seen = new Set(next.images.map((i) => i.url));
    for (const img of parsed) {
      if (seen.has(img.url)) {
        return c.json({ error: 'InvalidInput', message: `addImages: url ${img.url} already present` }, 400);
      }
      seen.add(img.url);
      next.images.push(img);
    }
  }

  if (input.removeImages) {
    if (!Array.isArray(input.removeImages)) {
      return c.json({ error: 'InvalidInput', message: 'removeImages must be an array of { url }' }, 400);
    }
    const urls = new Set<string>();
    for (const entry of input.removeImages) {
      if (!entry || typeof entry !== 'object' || typeof (entry as { url?: unknown }).url !== 'string') {
        return c.json({ error: 'InvalidInput', message: 'removeImages entries must have a string url' }, 400);
      }
      urls.add((entry as { url: string }).url);
    }
    const present = new Set(next.images.map((i) => i.url));
    for (const url of urls) {
      if (!present.has(url)) {
        return c.json({ error: 'InvalidInput', message: `removeImages: url ${url} not present` }, 400);
      }
    }
    next.images = next.images.filter((i) => !urls.has(i.url));
  }

  if (input.addIdentifiers) {
    const parsed = parseIdentifierArray(input.addIdentifiers);
    if (!parsed) {
      return c.json({ error: 'InvalidInput', message: 'addIdentifiers must be an array of { type, value }' }, 400);
    }
    const present = new Set(next.identifiers.map((i) => `${i.type}::${i.value}`));
    for (const ident of parsed) {
      const key = `${ident.type}::${ident.value}`;
      if (present.has(key)) {
        return c.json({ error: 'InvalidInput', message: `addIdentifiers: (${ident.type}, ${ident.value}) already present` }, 400);
      }
      present.add(key);
      next.identifiers.push(ident);
    }
  }

  if (input.removeIdentifiers) {
    const parsed = parseIdentifierArray(input.removeIdentifiers);
    if (!parsed) {
      return c.json({ error: 'InvalidInput', message: 'removeIdentifiers must be an array of { type, value }' }, 400);
    }
    const present = new Set(next.identifiers.map((i) => `${i.type}::${i.value}`));
    for (const ident of parsed) {
      const key = `${ident.type}::${ident.value}`;
      if (!present.has(key)) {
        return c.json({ error: 'InvalidInput', message: `removeIdentifiers: (${ident.type}, ${ident.value}) not present` }, 400);
      }
    }
    const removeKeys = new Set(parsed.map((i) => `${i.type}::${i.value}`));
    next.identifiers = next.identifiers.filter((i) => !removeKeys.has(`${i.type}::${i.value}`));
  }

  if (!next.name) {
    return c.json({ error: 'InvalidInput', message: 'name must remain non-empty' }, 400);
  }
  if (next.identifiers.length === 0) {
    return c.json({ error: 'InvalidInput', message: 'identifiers must remain non-empty' }, 400);
  }

  for (const ident of next.identifiers) {
    const dup = await findContributorByIdentifier(db, ident.type, ident.value);
    if (dup && dup.uri !== existing.uri) {
      log.warn({ did, ident, existingUri: dup.uri }, 'updateContributor rejected: identifier collision with another contributor');
      return c.json(
        {
          error: 'DuplicateContributor',
          message: `Identifier (${ident.type}, ${ident.value}) already used by another contributor`,
          existingUri: dup.uri,
        },
        409,
      );
    }
  }

  await db
    .update(contributors)
    .set({
      name: next.name,
      altNames: next.altNames,
      images: next.images,
      identifiers: next.identifiers,
      bio: next.bio,
    })
    .where(eq(contributors.uri, existing.uri))
    .run();

  log.info({ uri: existing.uri }, 'updateContributor complete');
  return c.json({ uri: existing.uri, cid: `bafyrei-${existing.uri.split('/').pop()}` });
}

export async function createContributorType(c: Context): Promise<Response> {
  const log = c.get('log') as import('pino').Logger;
  const did = await requireAuth(
    c.req.raw.headers,
    'community.lexicon.book.contributor.createType',
  );

  if (!isLibrarian(did)) {
    log.warn({ did }, 'createContributorType rejected: not librarian');
    return c.json({ error: 'Forbidden', message: 'Librarian privileges required' }, 403);
  }

  const input = await c.req.json<CreateContributorTypeInput>();

  if (!input.name || typeof input.name !== 'string') {
    log.warn({ did }, 'createContributorType rejected: missing name');
    return c.json({ error: 'InvalidInput', message: 'name is required' }, 400);
  }
  if (input.name.length > TYPE_NAME_MAX) {
    log.warn({ did, len: input.name.length }, 'createContributorType rejected: name too long');
    return c.json(
      { error: 'InvalidInput', message: `name must be ${TYPE_NAME_MAX} characters or fewer` },
      400,
    );
  }
  if (input.description !== undefined && input.description.length > TYPE_DESC_MAX) {
    log.warn({ did, len: input.description.length }, 'createContributorType rejected: description too long');
    return c.json(
      { error: 'InvalidInput', message: `description must be ${TYPE_DESC_MAX} characters or fewer` },
      400,
    );
  }

  const dup = await findContributorTypeByName(db, input.name);
  if (dup) {
    log.warn({ did, name: input.name, existingUri: dup.uri }, 'createContributorType rejected: duplicate name');
    return c.json(
      { error: 'DuplicateContributorType', message: `A contributor type named "${input.name}" already exists` },
      409,
    );
  }

  log.info({ did, name: input.name }, 'handling createContributorType');

  const { uri, rkey } = await insertContributorType(db, {
    did,
    name: input.name,
    description: input.description,
  });

  log.info({ uri }, 'createContributorType complete');
  return c.json({ uri, cid: `bafyrei-${rkey}` });
}

export {
  serializeContributor,
  serializeContributorType,
};
