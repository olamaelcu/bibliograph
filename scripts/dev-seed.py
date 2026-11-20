#!/usr/bin/env python3
"""Provision the local atproto fixture network and seed it with activity.

Two subcommands share one account path:

  accounts  create (or report) the fixed fixture accounts on the local PDS
  fixtures  ensure the accounts, write deterministic social + Livtet + Semble
            records, backfill HappyView, and verify a few queries return the
            seeded data

The network is hermetic: the PDS is `https://pds.127-0-0-1.sslip.io` (Caddy's
internal CA), DIDs are registered in the local PLC, and nothing is announced to
public relays (`PDS_CRAWLERS=""` in the compose file). The script never talks to
public plc.directory or the public network.

Determinism: the fixture list is code, timestamps are fixed offsets from
`FIXTURE_EPOCH`, and record keys are derived from the account index, so two
runs against the same catalog produce the same records. The catalog editions
are read from Postgres (`appview_book_lua` joined to `pds_cids`) rather than
invented, because the read views drop activity whose edition is missing.

TLS: `.cache/caddy-root.crt` (written by `mise run hv-ca`) is used as the CA
bundle when present. Without it, verification is disabled **only** for a local
host (`127.0.0.1`, `localhost`, `*.sslip.io`) and a warning is printed; any
other host is a hard error, so this file cannot silently trust an unverified
remote origin.

Usage:
  scripts/dev-seed.py accounts [--count 8] [--handle H] [--email E] [--password P]
  scripts/dev-seed.py fixtures [--count 8] [--reset] [--password P]
  scripts/dev-seed.py author [--entries 3] [--no-giveaway] [--password P]
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlparse
from urllib.request import Request, urlopen

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

PDS = (os.environ.get("PDS_URL") or "https://pds.127-0-0-1.sslip.io").rstrip("/")
HANDLE_DOMAIN = urlparse(PDS).hostname or "pds.127-0-0-1.sslip.io"
HAPPYVIEW = (os.environ.get("HAPPYVIEW_URL") or "http://127.0.0.1:3000").rstrip("/")
ADMIN_KEY = os.environ.get("HAPPYVIEW_ADMIN_KEY") or "hv_dev_admin"
CLIENT_KEY = os.environ.get("HAPPYVIEW_CLIENT_KEY") or ""
CLIENT_SECRET = os.environ.get("HAPPYVIEW_CLIENT_SECRET") or ""
DATABASE_URL = (
    os.environ.get("DATABASE_URL")
    or "postgres://bibliograph:bibliograph@localhost:5432/bibliograph"
)
DEFAULT_PASSWORD = (
    os.environ.get("HV_SEED_PASSWORD")
    or os.environ.get("HV_ACCOUNT_PASSWORD")
    or "Dev-account-password1"
)
DEFAULT_COUNT = int(os.environ.get("HV_SEED_ACCOUNTS") or "8")

SHELF = "net.olamaelcu.livtet.biblio.shelf"
SHELF_ITEM = "net.olamaelcu.livtet.biblio.shelfItem"
BOOK_STATUS = "net.olamaelcu.livtet.biblio.bookStatus"
FOLLOW = "net.olamaelcu.livtet.biblio.follow"
READING_GOAL = "net.olamaelcu.livtet.biblio.readingGoal"
# The canonical collection: `net.olamaelcu.livtet.actor.profile` is the one it
# replaced, and the AppView reads only the canonical one — a fixture written
# under the retired name is a reader no chip can name.
PROFILE = "net.olamaelcu.livtet.biblio.actor.profile"
REVIEW = "community.lexicon.media.book.review"
# A reply in a review's conversation: a public record in the replier's own
# repo, naming the review it answers, and the reaction that bar reads.
REVIEW_REPLY = "net.olamaelcu.livtet.biblio.reviewReply"
REACTION = "community.lexicon.interaction.reaction"
BSKY_PROFILE = "app.bsky.actor.profile"
BSKY_FOLLOW = "app.bsky.graph.follow"
BSKY_POST = "app.bsky.feed.post"
BSKY_LIKE = "app.bsky.feed.like"

# Semble's records. A URL card names the page it saves; a collection is what
# a reader files it into; a link joins the two. Livtet's "Featured in Semble"
# sections read them through the same query Semble's appview answers
# (`network.cosmik.collection.getForUrl`), so the fixtures below make those
# sections show real collections in development.
COSMIK_COLLECTION = "network.cosmik.collection"
COSMIK_CARD = "network.cosmik.card"
COSMIK_LINK = "network.cosmik.collectionLink"

# Giveaways. The author's record is in their own repo, one entry record per
# entrant is in each entrant's own repo, and `contributor_identities` is what
# makes the catalogue call that account a verified author of the book.
GIVEAWAY_EVENT = "net.olamaelcu.livtet.biblio.giveaway.event"
GIVEAWAY_ENTRY = "net.olamaelcu.livtet.biblio.giveaway.entry"
KNOWN_CONTRIBUTOR = "net.olamaelcu.livtet.biblio.knownContributor"

# The fixture author: an account the catalogue verifies as an author of a real
# edition, so a developer can sign in and exercise the author half of the
# giveaway flow. `mise run hv-author` prints its handle and password.
AUTHOR_LOCAL_PART = "giveaway-author"
AUTHOR_HANDLE = f"{AUTHOR_LOCAL_PART}.{HANDLE_DOMAIN}"
# TID-shaped literals: `key: tid` collections need realistic rkeys, and a
# constant keeps a re-run rewriting the same records instead of adding more.
GIVEAWAY_EVENT_RKEY = "3kgauthor0001"
GIVEAWAY_ENTRY_RKEY = "3kgentry000"
KNOWNCONTRIBUTOR_RKEY = "3kgknownc001"

# Collections HappyView indexes. One `{did}` backfill walks the repo and keeps
# only these, so a single job per account is enough.
INDEXED_COLLECTIONS = [
    SHELF,
    SHELF_ITEM,
    BOOK_STATUS,
    FOLLOW,
    READING_GOAL,
    PROFILE,
    REVIEW,
    REVIEW_REPLY,
    REACTION,
    # The giveaway reads go over the index, so these two have to be backfilled
    # like the rest: an unindexed entry is an entry the draw cannot see.
    GIVEAWAY_EVENT,
    GIVEAWAY_ENTRY,
]
# Everything the fixtures write; `--reset` deletes all of it.
SEEDED_COLLECTIONS = INDEXED_COLLECTIONS + [
    BSKY_PROFILE,
    BSKY_FOLLOW,
    BSKY_POST,
    BSKY_LIKE,
    COSMIK_COLLECTION,
    COSMIK_CARD,
    COSMIK_LINK,
]

FIXED_SHELVES = [
    ("reading", "Currently Reading"),
    ("read", "Read"),
    ("to-read", "To Read"),
    ("dnf", "Did Not Finish"),
]
CUSTOM_SHELF_RKEY = "autumn-stack"
CUSTOM_SHELF_NAME = "Autumn stack"

# Eight people, so the network has more than one conversation in it.
PEOPLE = [
    ("Mira Okafor", "Reads slowly, on purpose. Mostly literary fiction."),
    ("Tomas Reinholt", "Speculative fiction, long walks, short reviews."),
    ("Priya Raman", "Marginalia enthusiast and library-haunt."),
    ("Elias Varga", "Translator. Poetry and the occasional essay."),
    ("June Castellanos", "Book club or bust. Ask me about the ending."),
    ("Ahmed Farouk", "History, cities, and their ghosts."),
    ("Solveig Nystrom", "Short novels, long tea."),
    ("Kenji Watanabe", "Librarian in another life."),
]

POST_TEXTS = [
    "Halfway through {title} and already dreading the last page.",
    "Bookshop haul: {title}, plus two I did not need and do not regret.",
    "Coffee, rain, and {title}. A good Sunday.",
]
REVIEW_TEXTS = [
    "{title} is the rare book that earns its slow middle. I underlined more than I meant to.",
    "Read {title} in two sittings. The prose is spare and the ending lands.",
    "Not for me, but I see why people love {title}: the voice never wavers.",
]
REPLY_TEXTS = [
    "Agreed — the middle third is where it earns the ending.",
    "You read it faster than I did. Did the last chapter land for you?",
    "Adding this to the pile. Thanks for the warning about the slow part.",
]

# The reading statuses each account carries, in order. Every fixed shelf gets
# at least one book across the network.
STATUS_PLAN = ["reading", "reading", "read", "read", "to-read", "dnf"]

# ONIX Codelist 17 roles, the shape `community.lexicon.media.book.defs`
# expects. Keep in sync with happyview/lib/views.lua.
ONIX_ROLES = {
    "author": "A01",
    "co-author": "A01",
    "editor": "B01",
    "translator": "B06",
    "narrator": "E03",
    "illustrator": "A12",
    "photographer": "A08",
    "foreword": "A23",
    "preface": "A15",
}

FIXTURE_EPOCH = datetime(2026, 10, 5, 8, 0, 0, tzinfo=timezone.utc)

# TID alphabet: rkeys for `key: tid` collections must look like real record
# keys even though the local PDS is permissive.
TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz"


def _origins() -> list[str]:
    raw = os.environ.get("LIVTET_ORIGINS") or "http://127.0.0.1:6010,http://localhost:6010"
    return [origin.strip().rstrip("/") for origin in raw.split(",") if origin.strip()]


# Sorted by what a reader would actually curate: two open shelves and one the
# group keeps closed, so a page shows the "Collaborators only" label too.
SEMBLE_COLLECTIONS = [
    (
        "Books I press into hands",
        "The ones I buy a second copy of so I can lend without losing mine.",
        "OPEN",
    ),
    (
        "Winter reading",
        "Long, cold-weather novels. Best started in November.",
        "OPEN",
    ),
    (
        "Reading group picks",
        "Only the group adds here; ask before you link something.",
        "CLOSED",
    ),
]

# Rkeys are reserved per (account, page, origin slot) from a fixed stride, so
# adding or dropping an origin never shifts an existing record's key: the other
# origins' cards simply stop being written (and stop matching anything).
SEMBLE_ORIGIN_SLOTS = 4


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status


_SSL_CONTEXT: ssl.SSLContext | None = None


def ssl_context() -> ssl.SSLContext:
    """Caddy's root CA when available, else unverified for a local host only."""
    global _SSL_CONTEXT
    if _SSL_CONTEXT is not None:
        return _SSL_CONTEXT
    cafile = os.environ.get("HV_CA_FILE") or os.path.join(ROOT, ".cache", "caddy-root.crt")
    if os.path.exists(cafile):
        _SSL_CONTEXT = ssl.create_default_context(cafile=cafile)
        return _SSL_CONTEXT
    host = urlparse(PDS).hostname or ""
    if host in ("127.0.0.1", "::1", "localhost") or host.endswith(".sslip.io"):
        print(
            f"WARN: {cafile} is missing; TLS verification is disabled for {host}.\n"
            "      Run `mise run hv-ca` to export Caddy's CA and verify properly.",
            file=sys.stderr,
        )
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        _SSL_CONTEXT = ctx
        return ctx
    raise SystemExit(
        f"ERROR: {cafile} is missing and {host} is not a local host; "
        "refusing to disable certificate verification"
    )


def http(
    method: str,
    url: str,
    payload=None,
    token: str | None = None,
    headers: dict[str, str] | None = None,
    timeout: int = 60,
):
    data = None if payload is None else json.dumps(payload).encode()
    request_headers = {"Content-Type": "application/json"}
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    if headers:
        request_headers.update(headers)
    req = Request(url, data=data, method=method, headers=request_headers)
    try:
        with urlopen(req, timeout=timeout, context=ssl_context()) as res:
            raw = res.read().decode() or ""
    except HTTPError as err:
        detail = err.read().decode(errors="replace")
        raise ApiError(err.code, f"{method} {url} -> HTTP {err.code}: {detail}") from None
    except URLError as err:
        raise ApiError(0, f"{method} {url} failed: {err.reason}") from None
    return json.loads(raw) if raw.strip() else {}


def http_text(url: str, timeout: int = 10) -> str:
    try:
        with urlopen(Request(url, method="GET"), timeout=timeout, context=ssl_context()) as res:
            return res.read().decode()
    except HTTPError as err:
        raise ApiError(err.code, f"GET {url} -> HTTP {err.code}") from None
    except URLError as err:
        raise ApiError(0, f"GET {url} failed: {err.reason}") from None


# --------------------------------------------------------------------------
# accounts
# --------------------------------------------------------------------------


def handle_for(index: int) -> str:
    return f"seed-{index:02d}.{HANDLE_DOMAIN}"


def email_for(index: int) -> str:
    return f"seed-{index:02d}@example.invalid"


def resolve_handle(handle: str) -> str | None:
    url = f"{PDS}/xrpc/com.atproto.identity.resolveHandle?{urlencode({'handle': handle})}"
    try:
        return http("GET", url).get("did") or None
    except ApiError as err:
        # 400/404 is the reference PDS's "unknown handle". rsky-pds answers 500
        # InternalServerError for a handle on one of its own domains with no
        # account (its handler maps the resolver failure to RuntimeError), so a
        # fresh store looks like a server fault. A connection failure is status
        # 0 and still raises; a genuinely broken PDS then fails in
        # createAccount, not here.
        if err.status in (400, 404, 500):
            return None
        raise


def ensure_account(handle: str, email: str, password: str) -> str:
    existing = resolve_handle(handle)
    if existing:
        print(f"account already exists: {handle} -> {existing}")
        return existing
    created = http(
        "POST",
        f"{PDS}/xrpc/com.atproto.server.createAccount",
        {"handle": handle, "email": email, "password": password},
    )
    did = created.get("did")
    if not did:
        raise ApiError(0, f"account creation failed for {handle}: {created}")
    print(f"created {handle} -> {did}")
    return did


def ensure_accounts(count: int, password: str) -> dict[int, tuple[str, str]]:
    accounts: dict[int, tuple[str, str]] = {}
    for index in range(1, count + 1):
        handle = handle_for(index)
        did = ensure_account(handle, email_for(index), password)
        accounts[index] = (handle, did)
    return accounts


# --------------------------------------------------------------------------
# fixtures
# --------------------------------------------------------------------------


def tid(value: int) -> str:
    value &= (1 << 53) - 1
    return "3k" + "".join(
        TID_ALPHABET[(value >> (5 * shift)) & 0x1F] for shift in range(10, -1, -1)
    )


def is_tid(value: str) -> bool:
    return len(value) == 13 and all(char in TID_ALPHABET for char in value)


def stamp(minutes: int) -> str:
    return (FIXTURE_EPOCH + timedelta(minutes=minutes)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def ring(value: int, people: int) -> int:
    """Wrap a one-based account index onto the fixture ring."""
    return ((value - 1) % people) + 1


def psql_json(query: str):
    try:
        result = subprocess.run(
            ["psql", DATABASE_URL, "-tAc", query],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit("ERROR: psql is required to read the catalog editions") from None
    if result.returncode != 0:
        raise SystemExit(f"ERROR: psql failed: {result.stderr.strip()}")
    raw = result.stdout.strip()
    return json.loads(raw) if raw else None


def psql_rows(query: str) -> list[list[str]]:
    try:
        result = subprocess.run(
            ["psql", DATABASE_URL, "-tA", "-F", "\t", "-c", query],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit("ERROR: psql is required to read the activity index") from None
    if result.returncode != 0:
        raise SystemExit(f"ERROR: psql failed: {result.stderr.strip()}")
    return [line.split("\t") for line in result.stdout.splitlines() if line]


def load_editions(limit: int) -> list[dict]:
    """Deterministic catalog sample the fixtures may reference.

    Newest editions first. `catalog-seed` appends Project Gutenberg records, and
    these fixtures exist to exercise whatever the catalog holds right now, so a
    freshly seeded stack is what the shelves and reviews point at. `created_at`
    is the record's own timestamp (ingest time for imported editions) and `uri`
    breaks ties, so a fixed catalog always yields the same sample.
    """
    rows = psql_json(
        f"""
        SELECT json_agg(row_to_json(x)) FROM (
          SELECT v.uri, v.rkey, v.title,
                 v.identifiers, v.contributors, v.cover_url, c.cid
            FROM public.appview_book_lua v
            JOIN public.pds_cids c ON c.uri = v.uri
           WHERE v.identifiers IS NOT NULL AND v.identifiers <> '[]'
             AND v.contributors IS NOT NULL AND v.contributors <> '[]'
             AND v.cover_url IS NOT NULL
           ORDER BY v.created_at DESC, v.uri DESC
           LIMIT {limit}
        ) x
        """
    )
    if not rows:
        raise SystemExit(
            "ERROR: the catalog has no editions with identifiers, contributors, "
            "a cover and a published CID; run `mise run catalog-schema` and retry"
        )
    editions = []
    for row in rows:
        editions.append(
            {
                "uri": row["uri"],
                "rkey": row["rkey"],
                "title": row["title"],
                "identifiers": json.loads(row["identifiers"]),
                "contributors": json.loads(row["contributors"]),
                "coverUrl": row["cover_url"],
                "cid": row["cid"],
            }
        )
    return editions


def edition_ref(edition: dict) -> dict:
    contributors = []
    for entry in edition["contributors"]:
        name = entry.get("name")
        if not name:
            continue
        contributors.append(
            {
                "displayName": name,
                "role": ONIX_ROLES.get(str(entry.get("role") or "").lower(), "A01"),
            }
        )
    ref = {
        "title": edition["title"],
        "identifiers": edition["identifiers"],
        "contributors": contributors,
        "coverUrl": edition["coverUrl"],
    }
    return ref


def strong_ref(edition: dict) -> dict:
    return {"uri": edition["uri"], "cid": edition["cid"]}


# --------------------------------------------------------------------------
# the fixture author
# --------------------------------------------------------------------------

# Roles that make a contributor an author of the book. `isAuthorLikeRole` in the
# app accepts exactly these, and the give-away check depends on it: an editor or
# a translator cannot give the book away.
AUTHOR_ROLES_SQL = "('author', 'A01', 'intro_author', 'foreword_author', 'epilogue_author')"


def sql_literal(value: str) -> str:
    """A single-quoted SQL literal. Values here come from the database or a DID."""
    return "'" + value.replace("'", "''") + "'"


def psql_execute(query: str) -> None:
    try:
        result = subprocess.run(
            ["psql", DATABASE_URL, "-v", "ON_ERROR_STOP=1", "-qc", query],
            capture_output=True,
            text=True,
            check=False,
        )
    except FileNotFoundError:
        raise SystemExit("ERROR: psql is required to seed the contributor link") from None
    if result.returncode != 0:
        raise SystemExit(f"ERROR: psql failed: {result.stderr.strip()}")


def _author_candidates(sole_author: bool) -> list[dict]:
    """Contributors with a record and a published, covered edition, in a fixed order.

    Ordered by the contributor's own record uri and then the edition's, so two
    runs against the same catalog pick the same fixture author. `sole_author`
    restricts to editions this contributor authors alone, which is what makes the
    book page's card unambiguous (`verified as an author of this book`, not one of
    four authors).
    """
    sole = (
        f"""
           AND (SELECT count(*) FROM public.edition_contributors other
                 WHERE other.edition_uri = e.uri
                   AND other.role IN {AUTHOR_ROLES_SQL}) = 1
        """
        if sole_author
        else ""
    )
    rows = psql_json(
        f"""
        SELECT json_agg(row_to_json(x)) FROM (
          SELECT c.id           AS contributor_id,
                 c.at_uri       AS contributor_uri,
                 c.name         AS contributor_name,
                 e.uri          AS edition_uri,
                 e.rkey         AS edition_rkey,
                 e.title        AS title,
                 e.cover_url    AS cover_url,
                 k.cid          AS cid
            FROM public.contributors c
            JOIN public.edition_contributors ec ON ec.contributor_id = c.id
            JOIN public.appview_book_lua e ON e.uri = ec.edition_uri
            JOIN public.pds_cids k ON k.uri = e.uri
           WHERE c.at_uri IS NOT NULL
             AND e.cover_url IS NOT NULL
             AND ec.role IN {AUTHOR_ROLES_SQL}
             AND e.contributors::jsonb @>
                 jsonb_build_array(jsonb_build_object('ref', c.at_uri))
             {sole}
           ORDER BY c.at_uri, e.uri
        ) x
        """
    )
    return rows or []


def select_author_contributor() -> dict:
    """The contributor the fixture author is verified as, plus its editions.

    Sole-author editions are preferred and a shared credit is the fallback: a
    catalog that has nothing single-authored still yields a working fixture.
    """
    for sole_author in (True, False):
        rows = _author_candidates(sole_author)
        if not rows:
            continue
        if not sole_author:
            print("no sole-authored edition in the catalog; using a shared credit")
        chosen: dict = {}
        for row in rows:
            entry = chosen.setdefault(
                row["contributor_uri"],
                {
                    "contributor_id": row["contributor_id"],
                    "contributor_uri": row["contributor_uri"],
                    "contributor_name": row["contributor_name"],
                    "editions": [],
                },
            )
            if len(entry["editions"]) < 2:
                entry["editions"].append(row)
        # The first contributor in the fixed order that has a usable edition.
        for uri in sorted(chosen):
            if chosen[uri]["editions"]:
                return chosen[uri]
    raise SystemExit(
        "ERROR: no contributor is linked to a published, covered edition; "
        "run `mise run catalog-seed` first"
    )


def bind_author_identity(contributor: dict, did: str) -> str:
    """Record the verified link; answer the `knownContributor` uri it publishes as.

    The row is the whole point: `getContributorLink` reads this table, so the
    catalogue tells the app that this account is that contributor. The trigger on
    the table queues the `knownContributor` record at `at_uri`, so the binding is
    published to the repo as well and a real AppView agrees.
    """
    publisher = contributor["contributor_uri"].split("/")[2]
    known_uri = f"at://{publisher}/{KNOWN_CONTRIBUTOR}/{KNOWNCONTRIBUTOR_RKEY}"
    psql_execute(
        f"""
        INSERT INTO public.contributor_identities (contributor_id, did, at_uri, issued_by)
        VALUES ({int(contributor['contributor_id'])},
                {sql_literal(did)},
                {sql_literal(known_uri)},
                'mise run hv-author')
        ON CONFLICT (did) DO UPDATE
           SET contributor_id = EXCLUDED.contributor_id,
               at_uri = EXCLUDED.at_uri,
               issued_by = EXCLUDED.issued_by,
               updated_at = now()
        """
    )
    return known_uri


def giveaway_event_record(edition: dict) -> dict:
    """An open giveaway for one edition.

    Time-relative on purpose, unlike the rest of the fixtures: a giveaway whose
    window has closed cannot be entered and cannot show the book page's card, so
    a fixed date would make the fixture useless a fortnight after it was written.
    """
    now = datetime.now(timezone.utc)
    return {
        "$type": GIVEAWAY_EVENT,
        "edition": edition["edition_uri"],
        "title": f"{edition['title']} — signed copy giveaway",
        "prizeType": "print",
        "prizeQuantity": 2,
        "countries": ["*"],
        "rulesText": (
            "One entry per reader, worldwide. Two signed copies go to two readers "
            "drawn at random once the giveaway closes."
        ),
        "opensAt": (now - timedelta(days=2)).isoformat().replace("+00:00", "Z"),
        "closesAt": (now + timedelta(days=14)).isoformat().replace("+00:00", "Z"),
        "closingNote": "Thank you all for entering.",
        "createdAt": now.isoformat().replace("+00:00", "Z"),
        **({"coverUrl": edition["cover_url"]} if edition.get("cover_url") else {}),
    }


def giveaway_entry_record(giveaway_uri: str, giveaway_cid: str, country: str) -> dict:
    now = datetime.now(timezone.utc)
    return {
        "$type": GIVEAWAY_ENTRY,
        "giveaway": {"uri": giveaway_uri, "cid": giveaway_cid},
        "country": country,
        "createdAt": now.isoformat().replace("+00:00", "Z"),
    }


def fetch_records(did: str, collection: str, token: str) -> list[dict]:
    records: list[dict] = []
    cursor = None
    while True:
        params = {"repo": did, "collection": collection, "limit": 100}
        if cursor:
            params["cursor"] = cursor
        data = http(
            "GET",
            f"{PDS}/xrpc/com.atproto.repo.listRecords?{urlencode(params)}",
            token=token,
        )
        records.extend(data.get("records", []))
        cursor = data.get("cursor")
        if not cursor:
            return records


def fetch_record_keys(did: str, collection: str, token: str) -> set[str]:
    keys: set[str] = set()
    for record in fetch_records(did, collection, token):
        uri = record.get("uri", "")
        if "/" in uri:
            keys.add(uri.rsplit("/", 1)[-1])
    return keys


def follow_subject(value: str) -> str:
    subject = value[4:] if value.startswith("at://") else value
    return subject.split("/", 1)[0]


def reconcile_follows(did: str, token: str, records: list[dict]) -> None:
    """Delete legacy or duplicate follow rows for this account's targets.

    Fixture follows now use TID rkeys. A network seeded before that change has
    DID-keyed rows for the same subjects; delete them (and any duplicate TID)
    before upserting so a rerun converges on one record per target.
    """
    desired = {}
    for record in records:
        if record["collection"] != FOLLOW:
            continue
        subject = record["value"].get("subject")
        if isinstance(subject, str):
            desired[subject] = record["rkey"]
    if not desired:
        return

    desired_rkeys = set(desired.values())
    deletes = []
    for existing in fetch_records(did, FOLLOW, token):
        uri = existing.get("uri", "")
        rkey = uri.rsplit("/", 1)[-1] if "/" in uri else ""
        if not rkey or rkey in desired_rkeys:
            continue
        value = existing.get("value") or {}
        subject = value.get("subject")
        normalized = follow_subject(subject) if isinstance(subject, str) else None
        if normalized in desired or rkey in desired:
            deletes.append(
                {
                    "$type": "com.atproto.repo.applyWrites#delete",
                    "collection": FOLLOW,
                    "rkey": rkey,
                }
            )
    if deletes:
        apply_writes(did, token, deletes)
        print(f"{did} {FOLLOW}: removed {len(deletes)} legacy/duplicate follows")


def apply_writes(
    did: str, token: str, writes: list[dict], attempts: int = 3
) -> dict[str, str]:
    """Send applyWrites in batches; return uri -> cid for the written records."""
    cids: dict[str, str] = {}
    for start in range(0, len(writes), 100):
        batch = writes[start : start + 100]
        data = None
        # The local PDS answers InternalServerError instead of a 4xx for a write
        # it dislikes, so a 5xx is retried before the caller gives up on the
        # batch (and `--reset` means a half-written run leaves only an empty
        # network behind).
        for attempt in range(1, attempts + 1):
            try:
                data = http(
                    "POST",
                    f"{PDS}/xrpc/com.atproto.repo.applyWrites",
                    {"repo": did, "writes": batch},
                    token=token,
                )
                break
            except ApiError as err:
                if err.status < 500 or attempt == attempts:
                    raise
                print(f"{did}: applyWrites returned {err.status}; retrying ({attempt}/{attempts - 1})")
                time.sleep(2 * attempt)
        for result in data.get("results", []):
            uri, cid = result.get("uri"), result.get("cid")
            if uri and cid:
                cids[uri] = cid
    return cids


def upsert_writes(did: str, token: str, records: list[dict], existing: dict[str, set[str]]):
    writes = []
    for record in records:
        collection, rkey, value = record["collection"], record["rkey"], record["value"]
        op = "update" if rkey in existing.get(collection, set()) else "create"
        writes.append(
            {
                "$type": f"com.atproto.repo.applyWrites#{op}",
                "collection": collection,
                "rkey": rkey,
                "value": value,
            }
        )
    try:
        return apply_writes(did, token, writes)
    except ApiError as err:
        if err.status < 500:
            raise
        # One record the PDS will not take aborts the batch with a 500, and the
        # batch is the account's whole record set. Retrying record by record
        # seeds everything else and names what it had to skip, instead of
        # leaving the account empty and the run dead.
        print(f"{did}: applyWrites failed ({err.status}); writing one record at a time")
        cids: dict[str, str] = {}
        for record, write in zip(records, writes):
            try:
                cids.update(apply_writes(did, token, [write], attempts=1))
            except ApiError as record_error:
                print(
                    f"  skipped {record['collection']}/{record['rkey']}: "
                    f"HTTP {record_error.status}"
                )
        return cids


def fixture_records(
    index: int, did: str, editions: list[dict], dids: dict[int, str]
) -> list[dict]:
    """The deterministic record set for one account."""
    count = len(editions)
    people = len(dids)
    day = (index - 1) * 1440
    created = stamp(day)
    records: list[dict] = []

    def add(collection: str, rkey: str, value: dict) -> None:
        records.append({"collection": collection, "rkey": rkey, "value": value})

    display_name, description = PEOPLE[(index - 1) % len(PEOPLE)]

    add(
        PROFILE,
        "self",
        {
            "$type": PROFILE,
            "displayName": display_name,
            "description": description,
            "createdAt": created,
            "updatedAt": created,
        },
    )
    add(
        BSKY_PROFILE,
        "self",
        {
            "$type": BSKY_PROFILE,
            "displayName": display_name,
            "description": description,
            "createdAt": created,
        },
    )

    for slot, (rkey, name) in enumerate(FIXED_SHELVES):
        add(
            SHELF,
            rkey,
            {
                "$type": SHELF,
                "name": name,
                "createdAt": stamp(day + slot),
                "updatedAt": stamp(day + slot),
            },
        )
    add(
        SHELF,
        CUSTOM_SHELF_RKEY,
        {
            "$type": SHELF,
            "name": CUSTOM_SHELF_NAME,
            "description": "A changing pile of books for the season.",
            "createdAt": stamp(day + 5),
            "updatedAt": stamp(day + 5),
        },
    )

    for slot, status in enumerate(STATUS_PLAN):
        edition = editions[(index - 1 + slot) % count]
        metadata: dict = {"status": status, "position": slot + 1}
        if status in ("reading", "read", "dnf"):
            metadata["startedAt"] = stamp(day + 60 + slot * 10)
        if status == "read":
            metadata["finishedAt"] = stamp(day + 400 + slot * 10)
        add(
            BOOK_STATUS,
            edition["rkey"],
            {
                "$type": BOOK_STATUS,
                "shelf": f"at://{did}/{SHELF}/{status}",
                "book": strong_ref(edition),
                "metadata": metadata,
                "createdAt": stamp(day + 60 + slot * 10),
                "updatedAt": stamp(day + 60 + slot * 10),
            },
        )

    for slot in range(3):
        edition = editions[(index + 4 + slot) % count]
        add(
            SHELF_ITEM,
            f"{CUSTOM_SHELF_RKEY}-{edition['rkey']}",
            {
                "$type": SHELF_ITEM,
                "shelf": f"at://{did}/{SHELF}/{CUSTOM_SHELF_RKEY}",
                "book": strong_ref(edition),
                "metadata": {"position": slot + 1},
                "createdAt": stamp(day + 90 + slot),
                "updatedAt": stamp(day + 90 + slot),
            },
        )

    for slot in range(2):
        edition = editions[(index + 7 + slot) % count]
        rating = 8 + ((index + slot) % 5) * 2
        add(
            REVIEW,
            tid(9000 + index * 10 + slot),
            {
                "$type": REVIEW,
                "subject": edition_ref(edition),
                "subjectRecord": edition["uri"],
                "rating": rating,
                "textContent": REVIEW_TEXTS[(index + slot) % len(REVIEW_TEXTS)].format(
                    title=edition["title"]
                ),
                "createdAt": stamp(day + 200 + slot * 30),
            },
        )

    # Review conversations: each account answers the reviews of the two accounts
    # before it, and leaves one nested reply in each — a two-level discussion,
    # which is what the review permalink renders.
    for back in (1, 2):
        owner = ring(index - back, people)
        if owner == index:
            continue
        review_uri = f"at://{dids[owner]}/{REVIEW}/{tid(9000 + owner * 10)}"
        add(
            REVIEW_REPLY,
            tid(9500 + index * 10 + (back - 1) * 2),
            {
                "$type": REVIEW_REPLY,
                "subject": review_uri,
                "textContent": REPLY_TEXTS[(index + back) % len(REPLY_TEXTS)],
                "createdAt": stamp(day + 240 + back * 20),
            },
        )
        sibling = ring(owner + (3 - back), people)
        if sibling in (owner, index):
            continue
        add(
            REVIEW_REPLY,
            tid(9500 + index * 10 + (back - 1) * 2 + 1),
            {
                "$type": REVIEW_REPLY,
                "subject": review_uri,
                "replyTo": (
                    f"at://{dids[sibling]}/{REVIEW_REPLY}/"
                    f"{tid(9500 + sibling * 10 + (2 - back) * 2)}"
                ),
                "textContent": REPLY_TEXTS[(index + back + 1) % len(REPLY_TEXTS)],
                "createdAt": stamp(day + 260 + back * 20),
            },
        )

    # Ring + a third hop: everybody follows two people, so every account has a
    # populated graph in both the generic and the Livtet collections.
    targets = []
    for offset in (1, 3):
        target = ((index - 1 + offset) % people) + 1
        if target != index and target not in targets:
            targets.append(target)
    for slot, target in enumerate(targets):
        target_did = dids[target]
        follow_rkey = tid(4000 + index * 10 + slot)
        if not is_tid(follow_rkey) or follow_rkey == target_did:
            raise SystemExit(f"ERROR: fixture follow rkey is not a TID: {follow_rkey}")
        add(
            FOLLOW,
            follow_rkey,
            {
                "$type": FOLLOW,
                "subject": target_did,
                "createdAt": stamp(day + 20 + slot),
            },
        )
        add(
            BSKY_FOLLOW,
            tid(1000 + index * 10 + slot),
            {
                "$type": BSKY_FOLLOW,
                "subject": target_did,
                "createdAt": stamp(day + 20 + slot),
            },
        )

    for slot in range(3):
        edition = editions[(index + 1 + slot) % count]
        add(
            BSKY_POST,
            tid(2000 + index * 10 + slot),
            {
                "$type": BSKY_POST,
                "text": POST_TEXTS[slot].format(title=edition["title"]),
                "langs": ["en"],
                "createdAt": stamp(day + 10 + slot * 15),
            },
        )

    add(
        READING_GOAL,
        "current",
        {
            "$type": READING_GOAL,
            "period": "annual",
            "year": 2026,
            "booksGoal": 12 + index * 3,
            "createdAt": created,
            "updatedAt": created,
        },
    )

    return records


def split_at_uri(uri: str) -> tuple[str, str, str] | None:
    """`(did, collection, rkey)` for an at-uri, or None when it is not one."""
    if not uri.startswith("at://"):
        return None
    parts = uri[len("at://") :].split("/")
    return (parts[0], parts[1], parts[2]) if len(parts) == 3 else None


def semble_page_paths(index: int, did: str, editions: list[dict]) -> list[str]:
    """The Livtet pages one fixture account files into its collection.

    Two editions shared by every account are what makes a book page show a list
    of collections rather than just its curator's; the rest are the account's
    own shelf, one of its reviews, and a contributor it shares with the
    catalog — so all three permalink routes have fixture backlinks.
    """
    count = len(editions)
    paths: list[str] = []

    def add(path: str | None) -> None:
        if path and path not in paths:
            paths.append(path)

    def book_path(edition: dict) -> str | None:
        parts = split_at_uri(edition["uri"])
        return f"/book/{parts[0]}/{parts[2]}" if parts else None

    chosen = [editions[0], editions[1]] if count >= 2 else list(editions)
    chosen += [editions[(index - 1 + slot) % count] for slot in range(2)]
    for edition in chosen:
        add(book_path(edition))

    # The first review `fixture_records` writes for this account, and the first
    # contributor that edition names.
    add(f"/review/{did}/{tid(9000 + index * 10)}")
    contributor = next(
        (
            entry.get("ref")
            for edition in chosen
            for entry in edition.get("contributors", [])
            if entry.get("ref")
        ),
        None,
    )
    parts = split_at_uri(contributor) if contributor else None
    if parts:
        add(f"/contributor/{parts[0]}/{parts[2]}")
    return paths


def semble_records(index: int, did: str, editions: list[dict]) -> dict:
    """One account's Semble collection, its URL cards, and the links to write.

    A `collectionLink` is a strongRef to both the card and the collection, so
    its CIDs only exist after those records are written. The caller writes
    `records` first, then builds the link values from the returned CIDs; the
    tuples here are `(link_rkey, collection_rkey, card_rkey, added_at)`.
    """
    day = (index - 1) * 1440
    name, description, access = SEMBLE_COLLECTIONS[(index - 1) % len(SEMBLE_COLLECTIONS)]
    collection_rkey = tid(11000 + index * 10)
    records = [
        {
            "collection": COSMIK_COLLECTION,
            "rkey": collection_rkey,
            "value": {
                "$type": COSMIK_COLLECTION,
                "name": name,
                "description": description,
                "accessType": access,
                "createdAt": stamp(day + 480),
                "updatedAt": stamp(day + 520),
            },
        }
    ]

    origins = _origins()
    links: list[tuple[str, str, str, str]] = []
    if len(origins) > SEMBLE_ORIGIN_SLOTS:
        raise SystemExit(
            f"ERROR: LIVTET_ORIGINS names {len(origins)} origins; "
            f"the fixtures reserve {SEMBLE_ORIGIN_SLOTS}"
        )
    stride = SEMBLE_ORIGIN_SLOTS
    for slot, path in enumerate(semble_page_paths(index, did, editions)):
        added = stamp(day + 500 + slot)
        for origin_index, origin in enumerate(origins):
            card_rkey = tid(12000 + index * 100 + slot * stride + origin_index)
            link_rkey = tid(15000 + index * 100 + slot * stride + origin_index)
            if not is_tid(card_rkey) or not is_tid(link_rkey):
                raise SystemExit(f"ERROR: Semble fixture rkey is not a TID: {card_rkey}")
            url = origin + path
            records.append(
                {
                    "collection": COSMIK_CARD,
                    "rkey": card_rkey,
                    "value": {
                        "$type": COSMIK_CARD,
                        "type": "URL",
                        "url": url,
                        "content": {"url": url},
                        "createdAt": added,
                    },
                }
            )
            links.append((link_rkey, collection_rkey, card_rkey, added))
    return {"records": records, "links": links}


def reset_account(did: str, token: str) -> None:
    for collection in SEEDED_COLLECTIONS:
        keys = fetch_record_keys(did, collection, token)
        if not keys:
            continue
        writes = [
            {
                "$type": "com.atproto.repo.applyWrites#delete",
                "collection": collection,
                "rkey": rkey,
            }
            for rkey in sorted(keys)
        ]
        apply_writes(did, token, writes)
        noun = "record" if len(writes) == 1 else "records"
        print(f"reset {did} {collection}: {len(writes)} {noun}")


def clear_index(dids: list[str]) -> None:
    """Drop the index rows for the seed DIDs so `--reset` is a real reset."""
    urls = ", ".join("'" + did.replace("'", "''") + "'" for did in dids)
    prefix = ", ".join("'at://" + did.replace("'", "''") + "/%'" for did in dids)
    statements = [
        f"DELETE FROM happyview.happyview_record_refs WHERE source_uri LIKE ANY (ARRAY[{prefix}])",
        f"DELETE FROM happyview.happyview_records WHERE did = ANY (ARRAY[{urls}])",
    ]
    for statement in statements:
        result = subprocess.run(
            ["psql", DATABASE_URL, "-q", "-c", statement],
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            raise SystemExit(f"ERROR: clearing the index failed: {result.stderr.strip()}")


def backfill(did: str) -> str:
    data = http(
        "POST",
        f"{HAPPYVIEW}/admin/backfill",
        {"did": did},
        token=ADMIN_KEY,
        timeout=120,
    )
    return str(data.get("status") or "unknown")


def index_counts(dids: list[str]) -> dict[str, int]:
    urls = ", ".join("'" + did.replace("'", "''") + "'" for did in dids)
    rows = psql_rows(
        "SELECT collection, count(*) FROM happyview.happyview_records "
        f"WHERE did = ANY (ARRAY[{urls}]) GROUP BY 1 ORDER BY 1"
    )
    return {collection: int(total) for collection, total in rows}


def wait_for_index(dids: list[str], expected: dict[str, int], timeout: int = 120) -> dict[str, int]:
    deadline = time.monotonic() + timeout
    while True:
        actual = index_counts(dids)
        missing = {
            collection: (expected[collection], actual.get(collection, 0))
            for collection in expected
            if actual.get(collection, 0) < expected[collection]
        }
        if not missing:
            extra = {
                collection: actual[collection]
                for collection in actual
                if actual[collection] > expected.get(collection, 0)
            }
            if extra:
                print(
                    "WARN: the index holds more rows than this fixture set writes: "
                    + ", ".join(f"{c}={n}" for c, n in extra.items())
                    + " (run `mise run hv-fixtures --reset` for a clean slate)",
                    file=sys.stderr,
                )
            return actual
        if time.monotonic() >= deadline:
            raise SystemExit(
                "ERROR: HappyView did not index the seeded records within "
                f"{timeout}s: {missing}. Is the stack up and `mise run hv-deploy` applied?"
            )
        time.sleep(2)


def xrpc_query(nsid: str, params: dict) -> dict:
    headers = {}
    if CLIENT_KEY:
        headers["X-Client-Key"] = CLIENT_KEY
    if CLIENT_SECRET:
        headers["X-Client-Secret"] = CLIENT_SECRET
    return http("GET", f"{HAPPYVIEW}/xrpc/{nsid}?{urlencode(params)}", headers=headers)


def preflight() -> None:
    """The queries only resolve once `hv-deploy` has uploaded them."""
    try:
        if http_text(f"{HAPPYVIEW}/health").strip() != "ok":
            raise ApiError(0, "/health did not answer ok")
    except ApiError as err:
        raise SystemExit(f"ERROR: HappyView is not reachable at {HAPPYVIEW}: {err}") from None
    try:
        xrpc_query(
            "net.olamaelcu.livtet.biblio.listShelves",
            {"did": "did:plc:000000000000000000000000"},
        )
    except ApiError as err:
        if err.status in (404, 502):
            raise SystemExit(
                "ERROR: the Livtet query scripts are not deployed; run `mise run hv-deploy`"
            ) from None
        raise


def verify(accounts: dict[int, tuple[str, str]], editions: list[dict]) -> None:
    first_did = accounts[1][1]
    last_did = accounts[max(accounts)][1]

    shelves = xrpc_query(
        "net.olamaelcu.livtet.biblio.listShelvesWithBooks",
        {"did": first_did, "limit": 10, "booksPerShelf": 3},
    )
    recent = xrpc_query(
        "net.olamaelcu.livtet.biblio.listRecentShelving", {"limit": 5}
    )
    reviews = xrpc_query(
        "net.olamaelcu.livtet.biblio.getReviewsByBook",
        {"book": editions[0]["uri"], "limit": 5},
    )
    followees = xrpc_query(
        "net.olamaelcu.livtet.biblio.graph.listFollowees", {"did": first_did}
    )
    goal = xrpc_query("net.olamaelcu.livtet.biblio.getReadingGoal", {"did": last_did})
    custom_shelf = f"at://{first_did}/{SHELF}/{CUSTOM_SHELF_RKEY}"
    items = xrpc_query(
        "net.olamaelcu.livtet.biblio.listShelfItems", {"shelf": custom_shelf, "limit": 5}
    )
    conversation = xrpc_query(
        "net.olamaelcu.livtet.biblio.listReviewReplies",
        {"subject": f"at://{accounts[1][1]}/{REVIEW}/{tid(9010)}", "limit": 10},
    )

    shelf_rows = shelves.get("shelves") or []
    book_rows = recent.get("bookShelves") or []
    review_rows = reviews.get("reviews") or []
    follow_rows = followees.get("followees") or []
    item_rows = items.get("items") or []
    reply_rows = conversation.get("replies") or []

    checks = [
        ("listShelvesWithBooks", len(shelf_rows), 5),
        ("listShelfItems", len(item_rows), 3),
        ("listRecentShelving", len(book_rows), 5),
        ("getReviewsByBook", len(review_rows), 1),
        ("graph.listFollowees", len(follow_rows), 2),
        ("listReviewReplies", len(reply_rows), 2),
    ]
    if not any(reply.get("reactions") for reply in reply_rows):
        raise SystemExit(
            "ERROR: the seeded conversation carries no reactions; the index did "
            f"not take the reaction phase: {json.dumps(conversation)[:400]}"
        )
    failed = [name for name, actual, minimum in checks if actual < minimum]
    if failed or "booksGoal" not in json.dumps(goal):
        raise SystemExit(
            "ERROR: seeded records were indexed but the queries did not return them: "
            + ", ".join(f"{name}={actual} (want >= {minimum})" for name, actual, minimum in checks)
            + f"; reading goal response: {json.dumps(goal)[:200]}"
        )

    def show(label: str, payload: dict, limit: int = 2) -> None:
        if isinstance(payload, dict):
            trimmed = {}
            for key, value in payload.items():
                if isinstance(value, list):
                    trimmed[key] = value[:limit]
                else:
                    trimmed[key] = value
            payload = trimmed
        print(f"\n== {label} ==")
        print(json.dumps(payload, indent=2, ensure_ascii=False))

    show(
        f"listShelvesWithBooks?did={first_did}",
        {"shelves": shelf_rows[:2],
         "shelfCount": len(shelf_rows),
         "booksOnFirstShelf": len((shelf_rows[0] or {}).get("books", [])) if shelf_rows else 0},
    )
    show("listRecentShelving", recent, limit=2)
    show(f"getReviewsByBook?book={editions[0]['uri']}", reviews, limit=2)
    show(f"graph.listFollowees?did={first_did}", followees, limit=3)
    show(f"listShelfItems?shelf={custom_shelf}", items, limit=1)
    show(f"getReadingGoal?did={last_did}", goal)
    show(f"listReviewReplies?subject=<account 1's first review>", conversation, limit=2)


# --------------------------------------------------------------------------
# commands
# --------------------------------------------------------------------------


def command_accounts(args: argparse.Namespace) -> int:
    password = args.password or DEFAULT_PASSWORD
    if args.handle:
        handle = args.handle
        email = args.email or f"{handle.split('.')[0]}@example.invalid"
        ensure_account(handle, email, password)
        print(f"password: {password}")
        return 0

    count = args.count or DEFAULT_COUNT
    accounts = ensure_accounts(count, password)
    print(f"\n{len(accounts)} fixture accounts ready on {PDS}")
    for index, (handle, did) in accounts.items():
        print(f"  {handle:<44} {did}")
    print(f"password: {password}")
    return 0


def command_fixtures(args: argparse.Namespace) -> int:
    password = args.password or DEFAULT_PASSWORD
    count = args.count or DEFAULT_COUNT
    preflight()

    accounts = ensure_accounts(count, password)
    dids = {index: did for index, (_handle, did) in accounts.items()}
    editions = load_editions(limit=max(12, count + 6))
    print(f"catalog editions available to reference: {len(editions)}")

    sessions: dict[int, dict] = {}
    for index, (handle, did) in accounts.items():
        session = http(
            "POST",
            f"{PDS}/xrpc/com.atproto.server.createSession",
            {"identifier": handle, "password": password},
        )
        sessions[index] = {"did": did, "token": session["accessJwt"]}

    if args.reset:
        for index, (_handle, did) in accounts.items():
            reset_account(did, sessions[index]["token"])
        clear_index([did for _handle, did in accounts.values()])
        print("reset the seed accounts' records and their index rows")

    # Phase 1: every record except likes (a like needs its post's CID).
    record_cids: dict[str, str] = {}
    totals: dict[str, int] = {}
    for index, (_handle, did) in accounts.items():
        token = sessions[index]["token"]
        records = fixture_records(index, did, editions, dids)
        existing = {
            collection: fetch_record_keys(did, collection, token)
            for collection in SEEDED_COLLECTIONS
        }
        records = [r for r in records if r["collection"] != BSKY_LIKE]
        reconcile_follows(did, token, records)
        record_cids.update(upsert_writes(did, token, records, existing))
        for record in records:
            totals[record["collection"]] = totals.get(record["collection"], 0) + 1
        print(f"{accounts[index][0]}: wrote {len(records)} records")

    # Phase 1b: Semble's records — one collection per account, a URL card per
    # Livtet page, and the link that files each card into that collection. The
    # links are strongRefs, so they are written once the cards' cids exist.
    semble_totals = {COSMIK_COLLECTION: 0, COSMIK_CARD: 0, COSMIK_LINK: 0}
    for index, (_handle, did) in accounts.items():
        token = sessions[index]["token"]
        semble = semble_records(index, did, editions)
        existing = {
            collection: fetch_record_keys(did, collection, token)
            for collection in (COSMIK_COLLECTION, COSMIK_CARD, COSMIK_LINK)
        }
        written = upsert_writes(did, token, semble["records"], existing)

        links = []
        for rkey, collection_rkey, card_rkey, added in semble["links"]:
            card_uri = f"at://{did}/{COSMIK_CARD}/{card_rkey}"
            collection_uri = f"at://{did}/{COSMIK_COLLECTION}/{collection_rkey}"
            card_cid = written.get(card_uri)
            collection_cid = written.get(collection_uri)
            if not card_cid or not collection_cid:
                continue
            links.append(
                {
                    "collection": COSMIK_LINK,
                    "rkey": rkey,
                    "value": {
                        "$type": COSMIK_LINK,
                        "collection": {"uri": collection_uri, "cid": collection_cid},
                        "card": {"uri": card_uri, "cid": card_cid},
                        "addedBy": did,
                        "addedAt": added,
                        "createdAt": added,
                    },
                }
            )
        upsert_writes(did, token, links, existing)

        cards = len(semble["records"]) - 1
        semble_totals[COSMIK_COLLECTION] += 1
        semble_totals[COSMIK_CARD] += cards
        semble_totals[COSMIK_LINK] += len(links)
        print(f"{accounts[index][0]}: 1 collection, {cards} cards, {len(links)} links")
    for collection, seeded in semble_totals.items():
        totals[collection] = totals.get(collection, 0) + seeded

    # Phase 2: one like per account, on the next account's first post.
    likes = 0
    for index, (_handle, did) in accounts.items():
        token = sessions[index]["token"]
        target_index = (index % count) + 1
        target_did = accounts[target_index][1]
        post_uri = f"at://{target_did}/{BSKY_POST}/{tid(2000 + target_index * 10)}"
        post_cid = record_cids.get(post_uri)
        if not post_cid:
            continue
        like_uri = f"at://{did}/{BSKY_LIKE}/{tid(3000 + index * 10)}"
        existing = fetch_record_keys(did, BSKY_LIKE, token)
        rkey = like_uri.rsplit("/", 1)[-1]
        apply_writes(
            did,
            token,
            [
                {
                    "$type": "com.atproto.repo.applyWrites#"
                    + ("update" if rkey in existing else "create"),
                    "collection": BSKY_LIKE,
                    "rkey": rkey,
                    "value": {
                        "$type": BSKY_LIKE,
                        "subject": {"uri": post_uri, "cid": post_cid},
                        "createdAt": stamp((index - 1) * 1440 + 30),
                    },
                }
            ],
        )
        likes += 1
    totals[BSKY_LIKE] = likes

    # Phase 3: one reaction per account on the first reply its review received.
    # A reaction names its subject with a strongRef, so it can only be written
    # once phase 1's record cids exist.
    reactions = 0
    for index, (_handle, did) in accounts.items():
        token = sessions[index]["token"]
        target = ring(index + 1, count)
        reply_uri = f"at://{dids[target]}/{REVIEW_REPLY}/{tid(9500 + target * 10)}"
        reply_cid = record_cids.get(reply_uri)
        if not reply_cid:
            continue
        rkey = tid(9700 + index * 10)
        existing = fetch_record_keys(did, REACTION, token)
        apply_writes(
            did,
            token,
            [
                {
                    "$type": "com.atproto.repo.applyWrites#"
                    + ("update" if rkey in existing else "create"),
                    "collection": REACTION,
                    "rkey": rkey,
                    "value": {
                        "$type": REACTION,
                        "subject": {"uri": reply_uri, "cid": reply_cid},
                        "value": {
                            "$type": f"{REACTION}#unicodeEmoji",
                            "value": "❤️",
                        },
                        "createdAt": stamp((index - 1) * 1440 + 30),
                    },
                }
            ],
        )
        reactions += 1
    totals[REACTION] = reactions

    print("\nrecords written by collection:")
    for collection in sorted(totals):
        print(f"  {collection:<48} {totals[collection]}")

    print(f"\nbackfilling {len(accounts)} repos into {HAPPYVIEW} ...")
    for index, (_handle, did) in accounts.items():
        print(f"  {did}: {backfill(did)}")
    expected = {collection: totals.get(collection, 0) for collection in INDEXED_COLLECTIONS}
    actual = wait_for_index([did for _handle, did in accounts.values()], expected)

    print("\nindexed collections:")
    for collection in INDEXED_COLLECTIONS:
        print(f"  {collection:<48} {actual.get(collection, 0)}")

    verify(accounts, editions)
    print(f"\nfixture network ready: {count} accounts on {PDS}")
    for index, (handle, did) in accounts.items():
        print(f"  {handle:<44} {did}")
    print(f"password: {password}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    accounts = subparsers.add_parser("accounts", help="create the fixture accounts")
    accounts.add_argument("--count", type=int, default=None)
    accounts.add_argument("--handle", default=None)
    accounts.add_argument("--email", default=None)
    accounts.add_argument("--password", default=None)

    fixtures = subparsers.add_parser("fixtures", help="seed records, backfill, verify")
    fixtures.add_argument("--count", type=int, default=None)
    fixtures.add_argument("--password", default=None)
    fixtures.add_argument(
        "--reset",
        action="store_true",
        help="delete the seed accounts' records and index rows before seeding",
    )

    author = subparsers.add_parser(
        "author", help="create the verified fixture author and its giveaway"
    )
    author.add_argument("--count", type=int, default=None)
    author.add_argument("--password", default=None)
    author.add_argument(
        "--entries",
        type=int,
        default=3,
        help="how many seeded accounts enter the giveaway (0 writes none)",
    )
    author.add_argument(
        "--no-giveaway",
        action="store_true",
        help="seed the account and the contributor link only",
    )

    args = parser.parse_args()
    if args.command == "accounts":
        return command_accounts(args)
    if args.command == "author":
        return command_author(args)
    return command_fixtures(args)


def command_author(args: argparse.Namespace) -> int:
    """Create the fixture author and seed one open giveaway for it.

    Three things the app needs and only this stack can provide:

      * an account to sign in as;
      * a `contributor_identities` row, which is the record `getContributorLink`
        reads — so the catalogue answers with this account for a contributor that
        a published edition already credits (the same check the giveaway's create
        form runs);
      * a `giveaway.event` in that account's repo plus a few entries from the
        fixture accounts, so `/giveaways`, the book page's card and the author's
        funnel all have something in them.

    Idempotent: the account is reused, the identity row is upserted by DID and the
    records are rewritten at fixed rkeys. `--no-giveaway` seeds only the account
    and the link.
    """
    password = args.password or DEFAULT_PASSWORD
    preflight()

    contributor = select_author_contributor()
    edition = contributor["editions"][0]
    did = ensure_account(
        AUTHOR_HANDLE, f"{AUTHOR_LOCAL_PART}@example.invalid", password
    )
    known_uri = bind_author_identity(contributor, did)
    print(f"author: {AUTHOR_HANDLE} -> {did}")
    print(f"verified as {contributor['contributor_name']} ({contributor['contributor_uri']})")
    print(f"knownContributor record: {known_uri}")
    print(f"book page: /book/{edition['edition_uri'].split('at://')[1]}")

    touched = [did]
    giveaways: list[dict] = []
    if args.no_giveaway:
        print("skipped the giveaway record (--no-giveaway)")
    else:
        session = http(
            "POST",
            f"{PDS}/xrpc/com.atproto.server.createSession",
            {"identifier": AUTHOR_HANDLE, "password": password},
        )
        token = session["accessJwt"]
        event = giveaway_event_record(edition)
        written = upsert_writes(
            did,
            token,
            [{"collection": GIVEAWAY_EVENT, "rkey": GIVEAWAY_EVENT_RKEY, "value": event}],
            {GIVEAWAY_EVENT: fetch_record_keys(did, GIVEAWAY_EVENT, token)},
        )
        event_uri = f"at://{did}/{GIVEAWAY_EVENT}/{GIVEAWAY_EVENT_RKEY}"
        event_cid = written.get(event_uri)
        if not event_cid:
            raise SystemExit(f"ERROR: the PDS did not answer a cid for {event_uri}")
        print(f"giveaway: {event_uri}")

        # Entries are records in each entrant's own repo, so each needs its own
        # session. They are what gives the funnel numbers and the draw a pool.
        entries = args.entries
        if entries > 0:
            accounts = ensure_accounts(args.count or DEFAULT_COUNT, password)
            countries = ["FR", "BE", "CH", "GB", "ES"]
            wrote = 0
            for index in sorted(accounts)[:entries]:
                handle, entrant = accounts[index]
                entrant_session = http(
                    "POST",
                    f"{PDS}/xrpc/com.atproto.server.createSession",
                    {"identifier": handle, "password": password},
                )
                entrant_token = entrant_session["accessJwt"]
                rkey = f"{GIVEAWAY_ENTRY_RKEY}{index:02d}"
                upsert_writes(
                    entrant,
                    entrant_token,
                    [
                        {
                            "collection": GIVEAWAY_ENTRY,
                            "rkey": rkey,
                            "value": giveaway_entry_record(
                                event_uri, event_cid, countries[index % len(countries)]
                            ),
                        }
                    ],
                    {GIVEAWAY_ENTRY: fetch_record_keys(entrant, GIVEAWAY_ENTRY, entrant_token)},
                )
                touched.append(entrant)
                wrote += 1
            print(f"entries: {wrote} (one per seeded account)")

        # The edge queries read HappyView, whose only intake is backfill.
        # The edge queries read HappyView, whose only intake is backfill. The
        # expectation is what this run wrote, summed across the repos it wrote
        # into, so a collection the indexer does not keep times out here rather
        # than surfacing later as an empty page.
        for subject in touched:
            backfill(subject)
        expected = {GIVEAWAY_EVENT: 1}
        if len(touched) > 1:
            expected[GIVEAWAY_ENTRY] = len(touched) - 1
        actual = wait_for_index(touched, expected)
        print(
            f"indexed: {actual.get(GIVEAWAY_EVENT, 0)} giveaway(s), "
            f"{actual.get(GIVEAWAY_ENTRY, 0)} entr(y/ies)"
        )
        # Read the record back from the PDS, which is the one source that needs no
        # lexicon at all. The three giveaway queries are edge-served, not HappyView
        # scripts, so asking HappyView for the NSID would answer its own list shape
        # and prove nothing about what the app sees.
        try:
            record = http(
                "GET",
                f"{PDS}/xrpc/com.atproto.repo.getRecord?"
                + urlencode(
                    {"repo": did, "collection": GIVEAWAY_EVENT, "rkey": GIVEAWAY_EVENT_RKEY}
                ),
            )
            giveaways = [record.get("value") or {}]
        except ApiError as err:
            print(f"the giveaway record could not be read back ({err})")
            giveaways = []

    if giveaways:
        first = giveaways[0]
        print(
            f"the author's giveaway record reads back (prize: {first.get('prizeType')} "
            f"x{first.get('prizeQuantity')})"
        )
        print(f"giveaway page: /giveaways/{did}/{GIVEAWAY_EVENT_RKEY}")
    elif not args.no_giveaway:
        print("WARNING: the giveaway record could not be read back from the PDS")

    print(f"\nsign in as {AUTHOR_HANDLE}")
    print(f"password: {password}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
