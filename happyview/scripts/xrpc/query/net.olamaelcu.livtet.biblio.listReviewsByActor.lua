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

  -- Page first, map second. Joining `appview_bookhive_lua` across the whole
  -- union probed `edition_identifiers` once per bookhive record the actor ever
  -- wrote (1131 for the busiest reviewer, 24 ms each, 14.2 s total) and planned
  -- for 1.4 s. Each branch now takes its own index-ordered page (the actor's
  -- (did, collection, created_at DESC, uri DESC) index) and only the page's
  -- hive ids are looked up: 26 probes, 205 ms measured on the same actor.
  local rows = db.raw(
    [[WITH page AS MATERIALIZED (
        (SELECT r.uri, r.did, r.record, r.created_at, 'community' AS source,
                NULL::text AS hive_id
           FROM happyview_records AS r
          WHERE r.collection = $1 AND r.did = $2
          ORDER BY r.created_at DESC, r.uri DESC
          LIMIT ($5 + $3))
        UNION ALL
        (SELECT r.uri, r.did, r.record, r.created_at, 'bookhive' AS source,
                (r.record::jsonb)->>'hiveId' AS hive_id
           FROM happyview_records AS r
          WHERE r.collection = $4 AND r.did = $2
            AND btrim(COALESCE((r.record::jsonb)->>'review', '')) <> ''
          ORDER BY r.created_at DESC, r.uri DESC
          LIMIT ($5 + $3))
      ), mapped AS (
        SELECT p.hive_id, min(e.edition_uri) AS edition_uri
          FROM page p
          JOIN edition_identifiers e
            ON e.issuer = 'bookhive.buzz' AND e.value = p.hive_id
         WHERE p.hive_id IS NOT NULL
         GROUP BY p.hive_id
      )
      SELECT p.uri, p.did, p.record, p.created_at, p.source, mapped.edition_uri
        FROM page p
        LEFT JOIN mapped ON mapped.hive_id = p.hive_id
       ORDER BY p.created_at DESC, p.uri DESC
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
