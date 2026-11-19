-- 0032-contributor-identity.sql
--
-- Contributor claims: the link from a catalog contributor to the ATProto account
-- that proved it is that person, the librarian decisions behind it, and the
-- labeler that advertises the result.
--
-- Three write paths, one table each:
--
--   contributor_identities  the binding. One row per (contributor, account), so
--                           a person is one account and an account is one person.
--                           The generic `pds_enqueue_entity` trigger queues the
--                           `net.olamaelcu.livtet.biblio.knownContributor` record
--                           that publishes it, exactly like contributors and
--                           publishers.
--   contributor_claims      what a librarian decided about one claim record. The
--                           claim itself is the reader's own record in their own
--                           repo (indexed by HappyView); this is only the
--                           decision, so a withdrawal cannot forge an approval.
--   label_outbox            labels to sign. Drained by the worker's `labels.emit`
--                           task into `labeler_labels`.
--   labeler_labels          the signed label stream `com.atproto.label.queryLabels`
--                           and `subscribeLabels` serve, keyed by `seq`.
--
-- Additive and idempotent like its neighbours: `CREATE TABLE IF NOT EXISTS`,
-- `CREATE INDEX IF NOT EXISTS`, `CREATE OR REPLACE` for triggers. It never drops,
-- truncates or rewrites a row.
--
-- The librarian's own OAuth session lives here too rather than in the edge's
-- memory: the session must survive a deploy, and the edge is the only writer.

BEGIN;

-- ---------------------------------------------------------------------------
-- The binding
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contributor_identities (
  id             bigserial PRIMARY KEY,
  contributor_id bigint NOT NULL UNIQUE REFERENCES contributors(id) ON DELETE CASCADE,
  did            text   NOT NULL UNIQUE CHECK (did LIKE 'did:%'),
  at_uri         text   UNIQUE,
  issued_by      text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_identities_did_idx ON contributor_identities (did);

-- `pds_enqueue_entity` reads NEW.at_uri / OLD.at_uri and splits the rkey out of
-- it, so a delete queues a record delete and an insert queues a create. A NULL
-- at_uri (a row being rewritten by a merge) queues nothing.
CREATE OR REPLACE TRIGGER pds_enqueue_known_contributor_record
  AFTER INSERT OR UPDATE OR DELETE ON contributor_identities
  FOR EACH ROW EXECUTE FUNCTION pds_enqueue_entity('net.olamaelcu.livtet.biblio.knownContributor');

-- ---------------------------------------------------------------------------
-- The decisions
--
-- `approved`, `rejected` and `revoked` are all terminal facts about one claim
-- URI; "pending" is the absence of a row, so a reader who withdraws and claims
-- again gets a fresh pending state instead of inheriting an old decision.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS contributor_claims (
  claim_uri       text PRIMARY KEY,
  subject_did     text NOT NULL,
  contributor_uri text NOT NULL,
  state           text NOT NULL CHECK (state IN ('approved', 'rejected', 'revoked')),
  note            text,
  decided_by      text NOT NULL,
  decided_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contributor_claims_subject_idx ON contributor_claims (subject_did);

-- ---------------------------------------------------------------------------
-- The labeler
--
-- Retry policy mirrors `pds_outbox`: `attempts < 10` is part of the claim
-- predicate, `next_at` is the backoff, and `last_error` is what an operator
-- reads. The partial index is the claim's index.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS label_outbox (
  id         bigserial PRIMARY KEY,
  uri        text NOT NULL,
  val        text NOT NULL,
  neg        boolean NOT NULL DEFAULT false,
  attempts   integer NOT NULL DEFAULT 0,
  claimed_at timestamptz,
  next_at    timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS label_outbox_ready_idx ON label_outbox (next_at) WHERE attempts < 10;

-- `sig` is the raw 64-byte compact secp256k1 signature over the DAG-CBOR digest
-- of the label body; `cts` is the label's creation time, which the signature
-- covers, so it never moves once signed.
CREATE TABLE IF NOT EXISTS labeler_labels (
  seq        bigserial PRIMARY KEY,
  src        text NOT NULL,
  uri        text NOT NULL,
  cid        text,
  val        text NOT NULL,
  neg        boolean NOT NULL DEFAULT false,
  cts        timestamptz NOT NULL,
  exp        timestamptz,
  sig        bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- The newest row per (uri, val) is what `queryLabels` hydrates, and a negated
-- one suppresses the pair.
CREATE INDEX IF NOT EXISTS labeler_labels_uri_idx ON labeler_labels (uri, val, cts DESC);

-- ---------------------------------------------------------------------------
-- The librarian's ATProto sign-in
--
-- `@atproto/oauth-client-node` takes a StateStore and a SessionStore; both are
-- keyed by a short string and hold JSON. The edge is the only writer, so the
-- grant below is the one table pair it may write.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS librarian_oauth_state (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS librarian_oauth_state_expiry_idx ON librarian_oauth_state (expires_at);

CREATE TABLE IF NOT EXISTS librarian_sessions (
  did        text PRIMARY KEY,
  token_set  jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Grants for the edge
--
-- The production edge connects as `bibliograph-web`. It reads both claim tables
-- to answer `getContributorLink`, and it is the only writer of the two librarian
-- tables. Guarded like 0003 so a development database without the role applies
-- cleanly.
-- ---------------------------------------------------------------------------

DO $g$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bibliograph-web') THEN
    EXECUTE 'GRANT SELECT ON public.contributor_identities TO "bibliograph-web"';
    EXECUTE 'GRANT SELECT ON public.contributor_claims TO "bibliograph-web"';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.librarian_oauth_state TO "bibliograph-web"';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.librarian_sessions TO "bibliograph-web"';
  END IF;
END $g$;

COMMIT;
