-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getShelvingOfBook — one reader's relationship with
-- a book: its `bookStatus` rows and its `shelfItem` memberships, ordered by
-- record URI and paged with an offset cursor.
--
-- A `bookStatus` row and a `shelfItem` on the same shelf name the same
-- membership; the status row is the one returned, so a book shelved twice under
-- one shelf appears once. A status row written while `shelf` was optional names
-- its shelf implicitly, so the comparison derives it the way `shelf_uri_of`
-- does.
local STATUS_SHELF = "COALESCE((s.record::jsonb)->>'shelf', 'at://' || s.did || '/"
  .. SHELF_COLLECTION
  .. "/' || COALESCE((s.record::jsonb)->'metadata'->>'status', ''))"

function handle()
  local book, err = required_at_uri(params.book, 'book')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)
  local cache = view_cache()

  local rows = db.raw(
    [[SELECT r.uri, r.did, r.record, r.collection
        FROM happyview_records AS r
       WHERE r.collection IN ($1, $2) AND r.did = $3
         AND (r.record::jsonb)->'book'->>'uri' = $4
         AND (r.collection = $1 OR NOT EXISTS (
               SELECT 1 FROM happyview_records AS s
                WHERE s.collection = $1 AND s.did = $3
                  AND (s.record::jsonb)->'book'->>'uri' = $4
                  AND ]] .. STATUS_SHELF .. [[ = (r.record::jsonb)->>'shelf'))
       ORDER BY r.uri ASC
       LIMIT $5 OFFSET $6]],
    { BOOK_STATUS, SHELF_ITEM, did, book, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view = shelf_entry_view(rows[i], cache)
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { bookShelves = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
