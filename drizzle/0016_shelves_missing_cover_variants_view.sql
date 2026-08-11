-- Shelves that have a cover.medium URL but are missing at least one sized variant.
-- Used by the cover worker to discover which rows need transcoding.
CREATE VIEW IF NOT EXISTS shelves_missing_cover_variants AS
SELECT
  uri,
  cover,
  substr(uri, -13) AS rkey
FROM shelves
WHERE cover IS NOT NULL
  AND (
    json_extract(cover, '$.small')      IS NULL OR
    json_extract(cover, '$.large')      IS NULL OR
    json_extract(cover, '$.smallAvif')  IS NULL OR
    json_extract(cover, '$.mediumAvif') IS NULL OR
    json_extract(cover, '$.largeAvif')  IS NULL
  );
