-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listBooksOnShelf — one shelf's books.
--
-- Two record types say "this book is on that shelf": a `bookStatus` (which also
-- carries the reading status) and a `shelfItem` (membership only, the shape a
-- custom shelf uses). Both are returned. A shelf status row and a shelfItem for
-- the same book are the same membership, so the status row wins and the item is
-- suppressed.
--
-- A `bookStatus` written while `shelf` was optional names only a status; on a
-- fixed shelf those rows are matched through the status and their shelf URI
-- derived in `book_shelf_view`.
--
-- Keyset over `(created_at, uri)` descending. `created_at` must be selected:
-- the cursor is built from the last scanned row, so omitting it emitted a
-- cursor with no timestamp. The per-request cache deduplicates edition/shelf
-- lookups across the page.

function handle()
  local shelf, err = required_at_uri(params.shelf, 'shelf')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local did = did_of(shelf)
  if did == nil then return fail(400, 'InvalidRequest', 'shelf must be an AT-URI') end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = decode_cursor(params.cursor)
  local cursor_t = string_field(cursor.t) or ''
  local cursor_u = string_field(cursor.u) or ''
  -- '' on a custom shelf: only a fixed rkey can stand in for a missing `shelf`.
  local fixed = fixed_status(rkey_of(shelf)) or ''
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT r.uri, r.did, r.record, r.created_at, r.collection
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
         AND ($6 = '' OR (r.created_at, r.uri) < ($6, $7))
       ORDER BY r.created_at DESC, r.uri DESC
       LIMIT $8]],
    { BOOK_STATUS, SHELF_ITEM, did, shelf, fixed, cursor_t, cursor_u, limit + 1 }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = shelf_entry_view(rows[i], cache)
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { bookShelves = toarray(out) }
  if #rows > limit then
    local last = rows[limit]
    response.cursor = encode_cursor({ t = last.created_at, u = last.uri })
  end
  return response
end
