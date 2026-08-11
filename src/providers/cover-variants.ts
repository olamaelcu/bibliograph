import type { Cover, CoverSource } from '../cover-types.js';

export interface CoverVariantUrls {
  small?: string;
  medium?: string;
  large?: string;
}

export function olCoverVariantUrls(coverId: number): { small: string; medium: string; large: string } {
  const base = `https://covers.openlibrary.org/b/id/${coverId}`;
  return {
    small: `${base}-S.jpg`,
    medium: `${base}-M.jpg`,
    large: `${base}-L.jpg`,
  };
}

export function buildCover(
  source: CoverSource,
  urls: CoverVariantUrls,
): Cover {
  const cover: Cover = {
    source,
    updatedAt: new Date().toISOString(),
  };
  if (urls.small) cover.small = urls.small;
  if (urls.medium) cover.medium = urls.medium;
  if (urls.large) cover.large = urls.large;
  return cover;
}

export function firstCoverVariant(urls: CoverVariantUrls): string | undefined {
  return urls.medium ?? urls.small ?? urls.large;
}
