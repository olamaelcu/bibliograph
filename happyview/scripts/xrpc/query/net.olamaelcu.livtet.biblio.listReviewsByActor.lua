-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.listReviewsByActor — one DID's reviews.
--
-- Two sources share one feed, newest first: the DID's own
-- `community.lexicon.media.book.review` records, and its
-- `buzz.bookhive.book` records whose `review` text is non-empty, translated
-- into the shared review shape by `bookhive_review_view`. A stars-only
-- Bookhive record is shelving, not a review.
--
-- Newest first, offset cursor. The cursor advances by `limit` (the number of
-- rows the page emits), not by `limit + 1` (the probe row it scanned).

function handle()
  local did, err = required_did(params.did, 'did')
  if err ~= nil then return fail(400, 'InvalidRequest', err) end
  local limit = clamp_int(params.limit, 25, 1, 100)
  local offset = decode_offset(decode_cursor(params.cursor).o)

  local rows = db.raw(
    [[SELECT r.uri, r.did, r.record, r.created_at, 'community' AS source,
             NULL AS edition_uri
        FROM happyview_records AS r
       WHERE r.collection = $1 AND r.did = $2
      UNION ALL
      SELECT r.uri, r.did, r.record, r.created_at, 'bookhive' AS source, m.edition_uri
        FROM happyview_records AS r
        JOIN appview_bookhive_lua AS m
          ON m.hive_id = (r.record::jsonb)->>'hiveId'
       WHERE r.collection = $4 AND r.did = $2
         AND btrim(COALESCE((r.record::jsonb)->>'review', '')) <> ''
      ORDER BY created_at DESC, uri DESC
      LIMIT $3 OFFSET $5]],
    { REVIEW_COLLECTION, did, limit + 1, BOOKHIVE_BOOK, offset }
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
