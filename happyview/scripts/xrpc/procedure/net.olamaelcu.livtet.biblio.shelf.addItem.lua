-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addItem — put a book on a shelf.
--
-- The edge is found by the fields the record names: the caller's shelfItem
-- whose `record.shelf` is this shelf and whose `record.book.uri` is this book.
-- The rkey is a TID minted at write time, so deriving it from the two URIs
-- would miss the app's rows and mint a duplicate edge; a second call updates
-- the existing record instead. The target shelf must exist and belong to the
-- caller; a missing shelf is 404.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

  local book = strong_ref(input.book, true)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef {uri, cid} with an at:// uri')
  end

  local provided = nil
  if input.metadata ~= nil then
    local err
    provided, err = shelf_item_metadata(input.metadata)
    if err ~= nil then
      return fail(400, 'InvalidRequest', err)
    end
  end

  local found = db.raw(
    [[SELECT uri FROM happyview_records
       WHERE collection = $1 AND did = $2
         AND (record::jsonb)->>'shelf' = $3
         AND (record::jsonb)->'book'->>'uri' = $4
       ORDER BY uri ASC
       LIMIT 1]],
    { SHELF_ITEM, caller_did, shelf.uri, book.uri }
  )
  local record = nil
  if found[1] ~= nil then record = Record.load(found[1].uri) end
  local stamp = now()

  if record ~= nil then
    local metadata = copy_table(record.metadata)
    merge_fields(metadata, provided, { 'position', 'notes', 'emoji' })
    record.shelf = shelf.uri
    record.book = book
    record.metadata = metadata
    record.updatedAt = stamp
  else
    local metadata = copy_table(provided)
    record = Record(SHELF_ITEM, {
      shelf = shelf.uri,
      book = book,
      metadata = metadata,
      createdAt = stamp,
      updatedAt = stamp,
    })
    record:set_rkey(TID())
  end

  failure = pds_save(record)
  if failure ~= nil then return failure end
  return { uri = record._uri }
end
