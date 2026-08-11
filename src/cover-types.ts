export type CoverSize = 'S' | 'M' | 'L';
export type CoverFormat = 'jpg' | 'avif';
export type CoverCollection = 'book' | 'shelf';

export const COVER_SIZES: readonly CoverSize[] = ['S', 'M', 'L'] as const;
export const COVER_FORMATS: readonly CoverFormat[] = ['jpg', 'avif'] as const;
export const COVER_COLLECTIONS: readonly CoverCollection[] = ['book', 'shelf'] as const;

export const COVER_SIZE_PX: Record<CoverSize, number> = {
  S: 120,
  M: 400,
  L: 800,
};

export type CoverSource = 'openlibrary' | 'googlebooks' | 'goodreads' | 'user';

export interface Cover {
  small?: string;
  medium?: string;
  large?: string;
  smallAvif?: string;
  mediumAvif?: string;
  largeAvif?: string;
  color?: string;
  width?: number;
  height?: number;
  source?: CoverSource;
  updatedAt?: string;
}

export interface CoverVariant {
  size: CoverSize;
  format: CoverFormat;
  key: string;
  url: string;
}

export function isCoverSize(value: string | undefined): value is CoverSize {
  return typeof value === 'string' && (COVER_SIZES as readonly string[]).includes(value);
}

export function isCoverFormat(value: string | undefined): value is CoverFormat {
  return typeof value === 'string' && (COVER_FORMATS as readonly string[]).includes(value);
}

export function isCoverCollection(value: string | undefined): value is CoverCollection {
  return typeof value === 'string' && (COVER_COLLECTIONS as readonly string[]).includes(value);
}

export function variantUrl(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): string {
  const ext = format;
  return `/covers/${collection}/${rkey}-${size}.${ext}`;
}

export function variantKey(
  collection: CoverCollection,
  rkey: string,
  size: CoverSize,
  format: CoverFormat,
): string {
  return `${collection}/${rkey}-${size}.${format}`;
}

export function isLikelyRkey(value: string): boolean {
  return /^[234567abcdefghijklmnopqrstuvwxyz]{13}$/.test(value);
}

export function rkeyFromUri(uri: string): string {
  if (!uri.startsWith('at://')) {
    throw new Error(`rkeyFromUri: not an atproto URI: ${uri}`);
  }
  const slash = uri.lastIndexOf('/');
  if (slash === -1) {
    throw new Error(`rkeyFromUri: malformed URI: ${uri}`);
  }
  const rkey = uri.slice(slash + 1);
  if (!isLikelyRkey(rkey)) {
    throw new Error(`rkeyFromUri: URI does not end with a 13-char rkey: ${uri}`);
  }
  return rkey;
}

export function setCoverVariant(
  cover: Cover,
  size: CoverSize,
  format: CoverFormat,
  url: string,
): Cover {
  if (format === 'jpg') {
    const key = size === 'S' ? 'small' : size === 'M' ? 'medium' : 'large';
    return { ...cover, [key]: url };
  }
  const key = size === 'S' ? 'smallAvif' : size === 'M' ? 'mediumAvif' : 'largeAvif';
  return { ...cover, [key]: url };
}

export function getCoverVariant(
  cover: Cover,
  size: CoverSize,
  format: CoverFormat,
): string | undefined {
  if (format === 'jpg') {
    const key = size === 'S' ? 'small' : size === 'M' ? 'medium' : 'large';
    return cover[key];
  }
  const key = size === 'S' ? 'smallAvif' : size === 'M' ? 'mediumAvif' : 'largeAvif';
  return cover[key];
}

export function allCoverVariants(cover: Cover): Array<{ size: CoverSize; format: CoverFormat; url: string }> {
  const out: Array<{ size: CoverSize; format: CoverFormat; url: string }> = [];
  for (const size of COVER_SIZES) {
    for (const format of COVER_FORMATS) {
      const url = getCoverVariant(cover, size, format);
      if (url) out.push({ size, format, url });
    }
  }
  return out;
}

export function missingCoverVariants(cover: Cover): Array<{ size: CoverSize; format: CoverFormat }> {
  const out: Array<{ size: CoverSize; format: CoverFormat }> = [];
  for (const size of COVER_SIZES) {
    for (const format of COVER_FORMATS) {
      if (!getCoverVariant(cover, size, format)) {
        out.push({ size, format });
      }
    }
  }
  return out;
}

export function hasAnyCover(cover: Cover | null | undefined): boolean {
  if (!cover) return false;
  return Boolean(cover.medium || cover.small || cover.large);
}

/**
 * Build a minimal `Cover` object from a single URL. Use when the provider
 * supplies only one URL (where `url` is typically the medium); the worker
 * will pick the row up from the missing-variants view and fill in the rest.
 */
export function coverFromUrl(url: string | undefined, source: CoverSource): Cover | undefined {
  if (!url) return undefined;
  const cover: Cover = {
    medium: url,
    source,
    updatedAt: new Date().toISOString(),
  };
  return cover;
}

/**
 * Provider book data may carry a `coverUrl` (single URL) and/or a `cover`
 * (multi-size JSON). This helper returns whichever is richest, falling
 * back to deriving a minimal cover from `coverUrl`.
 */
export function deriveCover(args: {
  coverUrl?: string;
  cover?: Cover;
  source: CoverSource;
}): Cover | undefined {
  if (args.cover && hasAnyCover(args.cover)) return args.cover;
  if (args.coverUrl) return coverFromUrl(args.coverUrl, args.source);
  return undefined;
}
