-- @include lib/prelude.lua
-- net.olamaelcu.livtet.biblio.searchActors — the readers a picker can name.
--
-- The index already knows which repos hold a book record: a Livtet review or
-- shelving row, a Bookhive book, a Popfeed review or shelf item. This query
-- narrows that set by what the reader typed after `@` — part of a display
-- name — and answers the accounts a mention can be written for.
--
-- The answer is DIDs and names, not handles. A handle lives only in
-- `happyview_linked_repos`, which the engine protects from script SQL, and the
-- table's own rows are not a mention's business; the caller resolves a handle
-- from the DID when it needs one (a mention stores the DID, and its renderer
-- resolves the current handle). Display names come from the reader's own
-- Livtet profile record when the index has seen one, and they are what orders
-- the answer.

local MAX_QUERY = 50
local DEFAULT_LIMIT = 8
local MAX_LIMIT = 25

-- Readers who signed in before the profile record moved to the `biblio`
-- namespace still carry the older collection; a name is a name either way.
local LEGACY_PROFILE_COLLECTION = 'net.olamaelcu.livtet.actor.profile'

-- Escape the LIKE metacharacters a reader can type, so `%` and `_` in a query
-- match themselves instead of widening the search.
local function like_escape(value)
  return (value:gsub('([%%_\\])', '\\%1'))
end

function handle()
  local raw = params.q
  if type(raw) ~= 'string' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  local term = raw:match('^%s*(.-)%s*$')
  if term == '' then
    return fail(400, 'InvalidRequest', '`q` is required')
  end
  if #term > MAX_QUERY then
    return fail(400, 'InvalidRequest', '`q` must be at most ' .. MAX_QUERY .. ' characters')
  end

  local limit = clamp_int(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT)
  local name_contains = '%' .. like_escape(term:lower()) .. '%'

  -- The constants are compile-time strings, so the collection list is part of
  -- the statement rather than a parameter Postgres would have to type.
  local collections = table.concat({
    "'" .. REVIEW_COLLECTION .. "'",
    "'" .. BOOK_STATUS .. "'",
    "'" .. BOOKHIVE_BOOK .. "'",
    "'" .. POPFEED_REVIEW .. "'",
    "'" .. POPFEED_LIST_ITEM .. "'",
  }, ', ')

  local rows = db.raw(
    [[WITH readers AS (
        SELECT r.did, max(r.created_at) AS last_activity
          FROM happyview_records AS r
         WHERE r.collection IN (]] .. collections .. [[)
         GROUP BY r.did
      ),
      named AS (
        SELECT readers.did,
               readers.last_activity,
               (SELECT (profile.record::jsonb)->>'displayName'
                  FROM happyview_records AS profile
                 WHERE profile.did = readers.did
                   AND profile.collection IN (']] .. PROFILE_COLLECTION .. [[', ']] .. LEGACY_PROFILE_COLLECTION .. [[')
                 ORDER BY profile.created_at DESC
                 LIMIT 1) AS display_name
          FROM readers
      )
      SELECT did, display_name
        FROM named
       WHERE lower(coalesce(display_name, '')) LIKE $1
       ORDER BY last_activity DESC, lower(did) ASC
       LIMIT $2]],
    { name_contains, limit }
  )

  local actors = {}
  for i = 1, #rows do
    local row = rows[i]
    local actor = { did = row.did }
    if type(row.display_name) == 'string' and row.display_name ~= '' then
      actor.displayName = row.display_name
    end
    actors[#actors + 1] = actor
  end
  return { actors = toarray(actors) }
end
