-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.getReviewsByBook — reviews naming an edition.
--
-- Two sources share one feed, newest first:
--
-- * a `community.lexicon.media.book.review` record matches either
--   `subjectRecord` directly or an `(issuer, value)` pair from the edition's
--   identifier bag. The bag comes from `appview_book_lua.identifiers`, the same
--   catalog read model the view builders use; the activity plane reads no other
--   catalog table.
-- * a `buzz.bookhive.book` record whose `review` text is non-empty is a review
--   of the edition its `hiveId` was imported as (`appview_bookhive_lua`). The
--   row is translated into the shared review shape by
--   `bookhive_review_view`; a stars-only record is shelving, not a review.

function handle()
  local book, err = required_at_uri(params.book, 'book')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 25, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT uri, did, record, created_at, 'community' AS source, NULL AS edition_uri
        FROM happyview_records
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
      UNION ALL
      SELECT r.uri, r.did, r.record, r.created_at, 'bookhive' AS source, m.edition_uri
        FROM happyview_records AS r
        JOIN appview_bookhive_lua AS m
          ON m.hive_id = (r.record::jsonb)->>'hiveId'
       WHERE r.collection = $4
         AND m.edition_uri = $2
         AND btrim(COALESCE((r.record::jsonb)->>'review', '')) <> ''
      ORDER BY created_at DESC, uri DESC
      LIMIT $3 OFFSET $5]],
    { REVIEW_COLLECTION, book, limit + 1, BOOKHIVE_BOOK, offset }
  )

  local cache = view_cache()
  local out = {}
  for i = 1, math.min(#rows, limit) do
    local view
    if rows[i].source == 'bookhive' then
      view = bookhive_review_view(rows[i], rows[i].edition_uri, cache)
    else
      view = review_view(rows[i])
    end
    if view ~= nil then out[#out + 1] = view end
  end
  local response = { reviews = toarray(out) }
  if #rows > limit then response.cursor = offset_cursor(offset, limit) end
  return response
end
