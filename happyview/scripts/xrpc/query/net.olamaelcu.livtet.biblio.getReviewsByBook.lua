-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getReviewsByBook — reviews naming an edition.
--
-- A review matches either `subjectRecord` directly or an `(issuer, value)`
-- pair from the edition's identifier bag. The bag comes from
-- `appview_book_lua.identifiers`, the same catalog read model the view builders
-- use; the activity plane reads no other catalog table.

function handle()
  local book, err = required_at_uri(params.book, 'book')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 25, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at FROM happyview_records
       WHERE collection = $1
         AND (
           (record::jsonb)->>'subjectRecord' = $2
           OR EXISTS (
             SELECT 1
             FROM appview_book_lua AS edition,
                  jsonb_array_elements(
                    COALESCE(edition.identifiers::jsonb, '[]'::jsonb)
                  ) AS ident(value)
             WHERE edition.uri = $2
               AND (record::jsonb)->'subject'->'identifiers'
                   @> jsonb_build_array(jsonb_build_object(
                        'issuer', ident.value->>'issuer',
                        'value', ident.value->>'value'))
           )
         )
       ORDER BY created_at DESC, uri DESC
       LIMIT $3 OFFSET $4]],
    { REVIEW_COLLECTION, book, limit + 1, offset }
  )

  local out = {}
  for i = 1, math.min(#rows, limit) do
    out[#out + 1] = review_view(rows[i])
  end
  local response = { reviews = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
