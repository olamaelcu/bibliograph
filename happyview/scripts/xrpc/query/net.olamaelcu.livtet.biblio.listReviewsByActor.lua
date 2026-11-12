-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listReviewsByActor — one DID's reviews.
--
-- Newest first, offset cursor. The cursor advances by `limit` (the number of
-- rows the page emits), not by `limit + 1` (the probe row it scanned).

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 25, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1 AND did = $2
       ORDER BY created_at DESC, uri DESC
       LIMIT $3 OFFSET $4]],
    { REVIEW_COLLECTION, did, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    out[#out + 1] = review_view(rows[i])
  end
  local response = { reviews = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
