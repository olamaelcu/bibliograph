-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getShelversOfBook — distinct DIDs shelving a book.
--
-- Groups bookStatus rows by `did` for one `book.uri` and pages the groups by
-- `min(uri)`; the cursor is that smallest URI. The record key is never derived
-- from the book: the writer mints a TID per (reader, edition), so the only
-- association a row carries is the `book.uri` it names.

function handle()
  local bookUri, err = required_at_uri(params.bookUri, 'bookUri')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = string_field(decode_cursor(params.cursor).u) or ''

  local rows = db.raw(
    [[SELECT did, min(uri) AS first_uri FROM happyview_records
       WHERE collection = $1 AND (record::jsonb)->'book'->>'uri' = $2
       GROUP BY did
       HAVING ($3 = '' OR min(uri) > $3)
       ORDER BY first_uri ASC
       LIMIT $4]],
    { BOOK_STATUS, bookUri, cursor, limit + 1 }
  )

  local dids = {}
  for i = 1, math.min(#rows, limit) do
    dids[#dids + 1] = rows[i].did
  end
  local response = { bookUri = bookUri, dids = toarray(dids) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].first_uri }) end
  return response
end
