export const BOOKS_MISSING_COVER_VARIANTS = 'books_missing_cover_variants' as const;
export const SHELVES_MISSING_COVER_VARIANTS = 'shelves_missing_cover_variants' as const;

export const COVER_VIEWS = [
  BOOKS_MISSING_COVER_VARIANTS,
  SHELVES_MISSING_COVER_VARIANTS,
] as const;

export type CoverViewName = (typeof COVER_VIEWS)[number];
