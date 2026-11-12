export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize calls to one provider and leave a gap between them. Providers are
 * quota- or politeness-limited, so concurrency across jobs must not translate
 * into concurrent requests.
 */
export function createGate(intervalMs) {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task);
    tail = run.catch(() => {}).then(() => sleep(intervalMs));
    return run;
  };
}

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
};

export function stripHtml(value) {
  if (typeof value !== 'string') return undefined;
  const text = value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
      const decoded = ENTITIES[entity.toLowerCase()];
      if (decoded !== undefined) return decoded;
      if (entity[0] === '#') {
        const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
        return Number.isFinite(code) ? String.fromCodePoint(code) : match;
      }
      return match;
    })
    .replace(/\s+/g, ' ')
    .trim();
  return text === '' ? undefined : text;
}

export function cleanString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function isbn10To13(value) {
  if (typeof value !== 'string') return null;
  const core = value.replace(/[^0-9Xx]/g, '').toUpperCase();
  if (core.length !== 10) return null;

  let sum = 0;
  for (let index = 0; index < 9; index += 1) sum += Number(core[index]) * (10 - index);
  sum += core[9] === 'X' ? 10 : Number(core[9]);
  if (sum % 11 !== 0) return null;

  const base = `978${core.slice(0, 9)}`;
  let check = 0;
  for (let index = 0; index < 12; index += 1) check += Number(base[index]) * (index % 2 ? 3 : 1);
  return `${base}${(10 - (check % 10)) % 10}`;
}

export function isbn13(value) {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9Xx]/g, '');
  if (digits.length === 13 && /^[0-9]{13}$/.test(digits)) return digits;
  return isbn10To13(digits);
}

/** A stable key for a candidate so providers can be merged without duplicates. */
export function candidateKey(candidate) {
  const isbn = candidate.identifiers.find((identifier) => identifier.issuer === 'isbn13');
  if (isbn) return `isbn:${isbn.value}`;
  const google = candidate.identifiers.find((identifier) => identifier.issuer === 'googlebooks');
  if (google) return `gb:${google.value}`;
  const goodreads = candidate.identifiers.find((identifier) => identifier.issuer === 'goodreads');
  if (goodreads) return `gr:${goodreads.value}`;
  const openlibrary = candidate.identifiers.find(
    (identifier) => identifier.issuer === 'openlibrary'
  );
  if (openlibrary) return `ol:${openlibrary.value}`;
  return `title:${candidate.title.toLowerCase()}|${(candidate.contributors[0]?.name ?? '').toLowerCase()}`;
}

export function mergeCandidates(candidates) {
  const merged = new Map();
  for (const candidate of candidates) {
    if (!candidate?.title || !candidate.identifiers?.length) continue;
    const key = candidateKey(candidate);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, candidate);
      continue;
    }
    merged.set(key, {
      ...existing,
      ...Object.fromEntries(Object.entries(candidate).filter(([, value]) => value !== undefined)),
      identifiers: [...existing.identifiers, ...candidate.identifiers].filter(
        (identifier, index, list) =>
          list.findIndex(
            (other) => other.issuer === identifier.issuer && other.value === identifier.value
          ) === index
      ),
      contributors: existing.contributors?.length ? existing.contributors : candidate.contributors,
      publisher: existing.publisher ?? candidate.publisher
    });
  }
  return [...merged.values()];
}
