-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listShelvesWithBooks — shelves plus their books.
--
-- One shelf page, then one book query per shelf capped at `booksPerShelf`. Each
-- shelf's books are its `bookStatus` rows and its `shelfItem` memberships, with
-- the status row winning when both name the same book (see listBooksOnShelf).
--
-- The cap is applied after ordering, in SQL: a curated `metadata.position`
-- first, then record URI. Taking the first N by URI and sorting afterwards
-- dropped the lowest-positioned books of any shelf larger than the cap.
--
-- All view builders share one per-request cache, so a book or shelf repeated
-- across the page is looked up once. `did` is optional; an empty string is
-- treated as absent, a non-empty value must be a DID.

function handle()
  local limit = clamp_int(params.limit, 50, 1, 100)
  local booksPerShelf = clamp_int(params.booksPerShelf, 25, 1, 100)
  local cursor = string_field(decode_cursor(params.cursor).u) or ''

  local did = string_field(params.did)
  if did ~= nil then
    local err
    did, err = required_did(did, 'did')
    if err ~= nil then return fail(400, 'InvalidRequest', err) end
  else
    did = ''
  end

  local rows = db.raw(
    [[SELECT uri, did, record FROM happyview_records
       WHERE collection = $1
         AND ($2 = '' OR did = $2)
         AND ($3 = '' OR uri > $3)
       ORDER BY uri ASC
       LIMIT $4]],
    { SHELF_COLLECTION, did, cursor, limit + 1 }
  )

  local cache = view_cache()
  local shelves = {}
  for i = 1, math.min(#rows, limit) do
    local shelf_row = rows[i]
    local fixed = fixed_status(rkey_of(shelf_row.uri)) or ''
    local entries = db.raw(
      [[SELECT r.uri, r.did, r.record, r.collection
          FROM happyview_records AS r
         WHERE r.collection IN ($1, $2) AND r.did = $3
           AND ((r.record::jsonb)->>'shelf' = $4
                OR ($5 <> '' AND COALESCE((r.record::jsonb)->>'shelf', '') = ''
                    AND (r.record::jsonb)->'metadata'->>'status' = $5))
           AND (r.collection = $1 OR NOT EXISTS (
                 SELECT 1 FROM happyview_records AS s
                  WHERE s.collection = $1 AND s.did = $3
                    AND ((s.record::jsonb)->>'shelf' = $4
                         OR ($5 <> '' AND COALESCE((s.record::jsonb)->>'shelf', '') = ''
                             AND (s.record::jsonb)->'metadata'->>'status' = $5))
                    AND (s.record::jsonb)->'book'->>'uri' = (r.record::jsonb)->'book'->>'uri'))
         ORDER BY CASE WHEN (r.record::jsonb)->'metadata'->>'position' ~ '^[0-9]+$'
                       THEN ((r.record::jsonb)->'metadata'->>'position')::numeric END ASC NULLS LAST,
                  r.uri ASC
         LIMIT $6]],
      { BOOK_STATUS, SHELF_ITEM, shelf_row.did, shelf_row.uri, fixed, booksPerShelf }
    )
    local books = {}
    for _, entry in ipairs(entries) do
      local view = shelf_entry_view(entry, cache)
      if view ~= nil then books[#books + 1] = view end
    end
    shelves[#shelves + 1] = {
      shelf = shelf_view(shelf_row.uri, shelf_row.record),
      books = toarray(books),
    }
  end

  local response = { shelves = toarray(shelves) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].uri }) end
  return response
end
