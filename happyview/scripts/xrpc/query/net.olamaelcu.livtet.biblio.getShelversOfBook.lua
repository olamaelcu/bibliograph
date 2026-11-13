-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getShelversOfBook — distinct DIDs holding a book.
--
-- Groups the book's rows by `did` — a `bookStatus` counts, and so does a
-- `shelfItem` membership, because a reader who filed the book on a custom shelf
-- has shelved it just the same. Groups are paged by `min(uri)`; the cursor is
-- that smallest URI. The record key is never derived from the book: the writer
-- mints a TID per (reader, edition), so the only association a row carries is
-- the `book.uri` it names.

function handle()
  local bookUri, err = required_at_uri(params.bookUri, 'bookUri')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = string_field(decode_cursor(params.cursor).u) or ''

  local rows = db.raw(
    [[SELECT did, min(uri) AS first_uri FROM happyview_records
       WHERE collection IN ($1, $2) AND (record::jsonb)->'book'->>'uri' = $3
       GROUP BY did
       HAVING ($4 = '' OR min(uri) > $4)
       ORDER BY first_uri ASC
       LIMIT $5]],
    { BOOK_STATUS, SHELF_ITEM, bookUri, cursor, limit + 1 }
  )

  local dids = {}
  for i = 1, math.min(#rows, limit) do
    dids[#dids + 1] = rows[i].did
  end
  local response = { bookUri = bookUri, dids = toarray(dids) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].first_uri }) end
  return response
end
