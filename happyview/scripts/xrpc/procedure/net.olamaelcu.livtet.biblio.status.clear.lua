-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.status.clear — delete one edition's status.
--
-- The rkey is the edition rkey, so `book` alone names the record.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local book = strong_ref(input.book, false)
  if book == nil then
    return fail(400, 'InvalidRequest', '`book` must be a strongRef or {uri} with an at:// uri')
  end
  local _, _, book_rkey = at_uri_parts(book.uri)

  local uri = 'at://' .. caller_did .. '/' .. BOOK_STATUS .. '/' .. book_rkey
  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', 'no reading status for ' .. book.uri)
  end

  local failure = pds_delete(record)
  if failure ~= nil then return failure end
  return { uri = uri }
end
