-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.shelf.addBooks — batch shelf.addItem.
--
-- Every entry is validated first; entries that fail validation (bad strongRef,
-- duplicate (shelf, book) pair inside the request) are counted in `failed`
-- instead of failing the call. The caller's existing edges are resolved in one
-- query keyed by the pair the records name — their keys are TIDs, so the key
-- cannot tell two pairs apart — then saved with Record.save_all, which issues
-- the PDS writes in parallel. The target shelf is checked for existence and
-- ownership before any record is written.

local MAX_BOOKS = 100

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local shelf, failure = owned_shelf(input.shelf)
  if failure ~= nil then return failure end

  if type(input.books) ~= 'table' then
    return fail(400, 'InvalidRequest', '`books` must be an array of strongRefs')
  end
  if #input.books > MAX_BOOKS then
    return fail(400, 'InvalidRequest', '`books` may hold at most ' .. MAX_BOOKS .. ' entries')
  end

  local stamp = now()
  local wanted = {}
  local seen = {}
  local failed = 0

  for _, entry in ipairs(input.books) do
    local book = strong_ref(entry, true)
    if book == nil or seen[book.uri] then
      failed = failed + 1
    else
      seen[book.uri] = true
      wanted[#wanted + 1] = book
    end
  end

  local records = {}
  if #wanted > 0 then
    -- One lookup for the whole batch, keyed by the pair each record names. The
    -- pair list travels as a JSON array because db.raw binds scalars only.
    local uris = {}
    for i, book in ipairs(wanted) do uris[i] = book.uri end
    local rows = db.raw(
      [[SELECT uri, (record::jsonb)->'book'->>'uri' AS book_uri
          FROM happyview_records
         WHERE collection = $1 AND did = $2
           AND (record::jsonb)->>'shelf' = $3
           AND (record::jsonb)->'book'->>'uri' IN (
                 SELECT jsonb_array_elements_text($4::jsonb))
         ORDER BY uri ASC]],
      { SHELF_ITEM, caller_did, shelf.uri, json.encode(uris) }
    )

    local existing_uris = {}
    local existing_by_book = {}
    for _, row in ipairs(rows) do
      local book_uri = row.book_uri
      if row.uri ~= nil and book_uri ~= nil and existing_by_book[book_uri] == nil then
        existing_by_book[book_uri] = row.uri
        existing_uris[#existing_uris + 1] = row.uri
      end
    end

    -- The existing records load in one batch; a uri the PDS no longer has (a
    -- stale index row) falls back to a create, like a missing one.
    local loaded = {}
    if #existing_uris > 0 then
      local found, err = pds_load_all(existing_uris)
      if found == nil then
        return fail(502, 'UpstreamFailure', 'could not load shelf items: ' .. tostring(err))
      end
      for i = 1, #existing_uris do loaded[existing_uris[i]] = found[i] end
    end

    for _, book in ipairs(wanted) do
      local uri = existing_by_book[book.uri]
      local record = nil
      if uri ~= nil then record = loaded[uri] end
      if record ~= nil then
        record.shelf = shelf.uri
        record.book = book
        record.updatedAt = stamp
      else
        record = Record(SHELF_ITEM, {
          shelf = shelf.uri,
          book = book,
          createdAt = stamp,
          updatedAt = stamp,
        })
        record:set_rkey(TID())
      end
      records[#records + 1] = record
    end
  end

  if #records > 0 then
    failure = pds_save_all(records)
    if failure ~= nil then return failure end
  end

  return { added = #records, failed = failed }
end
