-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getShelversOfBook — distinct DIDs shelving a book.
--
-- Groups bookStatus rows by `did` for one `(shelvingRkey, bookUri)` pair and
-- pages the groups by `min(uri)`; the cursor is that smallest URI.

function handle()
  local bookUri, err = required_at_uri(params.bookUri, 'bookUri')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local shelvingRkey = string_field(params.shelvingRkey)
  if shelvingRkey == nil then
    shelvingRkey = string.match(bookUri, '([^/]+)$') or ''
  end
  local limit = clamp_int(params.limit, 50, 1, 100)
  local cursor = string_field(decode_cursor(params.cursor).u) or ''

  local rows = db.raw(
    [[SELECT did, min(uri) AS first_uri FROM happyview_records
       WHERE collection = $1 AND rkey = $2 AND (record::jsonb)->'book'->>'uri' = $3
       GROUP BY did
       HAVING ($4 = '' OR min(uri) > $4)
       ORDER BY first_uri ASC
       LIMIT $5]],
    { BOOK_STATUS, shelvingRkey, bookUri, cursor, limit + 1 }
  )

  local dids = {}
  for i = 1, math.min(#rows, limit) do
    dids[#dids + 1] = rows[i].did
  end
  local response = { bookUri = bookUri, dids = toarray(dids) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].first_uri }) end
  return response
end
