-- Actor-scoped shelf reads.
--
-- `listShelvesWithBooks?did=` filters `records` on owner and collection, and no
-- index covered that pair: the read would ride records_collection_idx and sort
-- every shelf record in the mirror to answer one reader's two shelves.
-- Composite because either column alone is too broad to narrow the scan.
CREATE INDEX IF NOT EXISTS records_did_collection_idx
  ON records (did, collection);
