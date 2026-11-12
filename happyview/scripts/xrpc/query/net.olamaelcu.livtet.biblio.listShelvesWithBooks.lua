-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listShelvesWithBooks — shelves plus their books.
--
-- One shelf page, then one bookStatus query per shelf capped at
-- `booksPerShelf`. All view builders share one per-request cache, so a book or
-- shelf repeated across the page is looked up once. `did` is optional; an empty
-- string is treated as absent, a non-empty value must be a DID.

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
    local entries = db.raw(
      [[SELECT uri, did, record FROM happyview_records
         WHERE collection = $1 AND did = $2 AND (record::jsonb)->>'shelf' = $3
         ORDER BY uri ASC
         LIMIT $4]],
      { BOOK_STATUS, shelf_row.did, shelf_row.uri, booksPerShelf }
    )
    local books = {}
    for _, entry in ipairs(entries) do
      local view = book_shelf_view(entry, cache)
      if view ~= nil then books[#books + 1] = view end
    end
    table.sort(books, function(a, b)
      local pa = a.metadata and a.metadata.position
      local pb = b.metadata and b.metadata.position
      if pa == nil and pb ~= nil then return false end
      if pa ~= nil and pb == nil then return true end
      if pa ~= nil and pb ~= nil and pa ~= pb then return pa < pb end
      return a.uri < b.uri
    end)
    shelves[#shelves + 1] = {
      shelf = shelf_view(shelf_row.uri, shelf_row.record),
      books = toarray(books),
    }
  end

  local response = { shelves = toarray(shelves) }
  if #rows > limit then response.cursor = encode_cursor({ u = rows[limit].uri }) end
  return response
end
