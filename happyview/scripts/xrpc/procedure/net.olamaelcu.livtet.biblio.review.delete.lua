-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.review.delete — delete one of the caller's reviews.

function handle()
  if type(input) ~= 'table' then
    return fail(400, 'InvalidRequest', 'the request body must be a JSON object')
  end

  local uri = string_field(input.uri)
  if uri == nil then
    return fail(400, 'InvalidRequest', '`uri` must be a review AT-URI')
  end
  local did, coll = at_uri_parts(uri)
  if did == nil or coll ~= REVIEW_COLLECTION then
    return fail(400, 'InvalidRequest', '`uri` must be an AT-URI in ' .. REVIEW_COLLECTION)
  end
  if did ~= caller_did then
    return fail(403, 'Forbidden', 'review ' .. uri .. ' belongs to another DID')
  end

  local record = Record.load(uri)
  if record == nil then
    return fail(404, 'NotFound', 'no review record at ' .. uri)
  end

  record:delete()
  return { uri = uri }
end
