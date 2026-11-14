#!/usr/bin/env node
// End-to-end smoke test for permissioned-data spaces on the local rsky PDS.
//
// Exercises both halves of the space API:
//
//   * the space-management surface (`com.atproto.simplespace.*`) and the
//     owner path (`com.atproto.space.putRecord`, `listRecords`) with a plain
//     account session, and
//   * the permissioned path a third-party app takes: `getDelegationToken`
//     (a single-use grant signed by the account key), the DPoP issuance proof
//     that exchanges it for a space credential, and `getSpace` presented as
//     `Authorization: DPoP <credential>` with an `ath`-bound proof.
//
// Everything is idempotent: the space and its record keep the same URIs, so a
// rerun re-writes the same record and re-mints a fresh delegation token.
//
// Usage: scripts/space-smoke.mjs [--handle H] [--password P] [--type NSID] [--skey S]
//
// Environment: PDS_URL (default https://pds.127-0-0-1.sslip.io), HV_CA (Caddy
// root certificate, default .cache/caddy-root.crt).

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { URL } from "node:url";

const PDS = (process.env.PDS_URL ?? "https://pds.127-0-0-1.sslip.io").replace(/\/$/, "");
const CA_PATH = process.env.HV_CA ?? ".cache/caddy-root.crt";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith("--")) throw new Error(`unexpected argument: ${key}`);
  args.set(key.slice(2), process.argv[i + 1]);
}

const HANDLE = args.get("handle") ?? "alice.pds.127-0-0-1.sslip.io";
const PASSWORD = args.get("password") ?? "Dev-account-password1";
const SPACE_TYPE = args.get("type") ?? "community.lexicon.test.space";
const SKEY = args.get("skey") ?? "main";
const COLLECTION = process.env.SPACE_COLLECTION ?? "community.lexicon.test.post";
const RKEY = "smoke";

let ca;
try {
  ca = readFileSync(CA_PATH);
} catch {
  throw new Error(
    `${CA_PATH} is missing: run \`mise run hv-ca\` first so the local PDS certificate verifies`,
  );
}

function http(method, url, { body, headers = {} } = {}) {
  const target = new URL(url);
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const requestHeaders = { ...headers };
  if (payload) {
    requestHeaders["content-type"] = "application/json";
    requestHeaders["content-length"] = String(payload.length);
  }
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        method,
        hostname: target.hostname,
        port: target.port || 443,
        path: `${target.pathname}${target.search}`,
        headers: requestHeaders,
        ca,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          let json;
          try {
            json = text ? JSON.parse(text) : {};
          } catch {
            json = { raw: text };
          }
          if (res.statusCode >= 400) {
            reject(new Error(`${method} ${target.pathname} -> ${res.statusCode} ${text}`));
            return;
          }
          resolve(json);
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const xrpc = (nsid, opts) => `${PDS}/xrpc/${nsid}`;
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (value) => createHash("sha256").update(value).digest();

// A DPoP proof: ES256 over the compact JWS, `jwk` in the header so the server
// can derive the thumbprint the credential binds to.
function dpopProof({ method, url, key, accessToken }) {
  const target = new URL(url);
  // `htu` is origin + path with no query or fragment (RFC 9449 §4.2).
  const htu = `${target.origin}${target.pathname}`;
  const header = {
    typ: "dpop+jwt",
    alg: "ES256",
    jwk: key.publicKey.export({ format: "jwk" }),
  };
  const claims = {
    jti: randomBytes(16).toString("hex"),
    htm: method.toUpperCase(),
    htu,
    iat: Math.floor(Date.now() / 1000),
  };
  if (accessToken) claims.ath = b64u(sha256(accessToken));
  const signingInput = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: key.privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64u(signature)}`;
}

function report(step, detail) {
  console.log(`ok  ${step}${detail ? ` — ${detail}` : ""}`);
}

const session = await http("POST", xrpc("com.atproto.server.createSession"), {
  body: { identifier: HANDLE, password: PASSWORD },
});
const did = session.did;
if (!did) throw new Error("createSession returned no did");
report("createSession", `${HANDLE} -> ${did}`);

const bearer = { authorization: `Bearer ${session.accessJwt}` };

// --- space management (simplespace) ---------------------------------------

const existing = await http("GET", xrpc("com.atproto.space.listSpaces"), { headers: bearer });
let space = existing.spaces?.find((entry) => entry.isOwner)?.uri;
if (space) {
  report("listSpaces", `${space} (existing)`);
} else {
  const created = await http("POST", xrpc("com.atproto.simplespace.createSpace"), {
    headers: bearer,
    body: { type: SPACE_TYPE, skey: SKEY, config: { policy: "public" } },
  });
  space = created.uri;
  report("simplespace.createSpace", space);
}

// --- owner writes ---------------------------------------------------------

const record = {
  $type: COLLECTION,
  text: "space smoke record",
  createdAt: new Date().toISOString(),
};
const written = await http("POST", xrpc("com.atproto.space.putRecord"), {
  headers: bearer,
  body: { space, repo: did, collection: COLLECTION, rkey: RKEY, record },
});
report("space.putRecord", written.uri);

const listed = await http(
  "GET",
  `${xrpc("com.atproto.space.listRecords")}?${new URLSearchParams({
    space,
    repo: did,
    collection: COLLECTION,
  })}`,
  { headers: bearer },
);
// `space.listRecords` identifies a record by collection + rkey; the space URI
// itself is on the request, not on each row.
const isOurRecord = (entry) => entry.collection === COLLECTION && entry.rkey === RKEY;
if (!(listed.records ?? []).some(isOurRecord)) {
  throw new Error(`listRecords did not return ${COLLECTION}/${RKEY}`);
}
report("space.listRecords", `${listed.records.length} record(s)`);

const commit = await http(
  "GET",
  `${xrpc("com.atproto.space.getLatestCommit")}?${new URLSearchParams({ space, repo: did })}`,
  { headers: bearer },
);
if (!commit.commit?.rev) throw new Error("getLatestCommit returned no commit");
report("space.getLatestCommit", `rev ${commit.commit.rev}`);

// --- permissioned path (delegation -> credential -> reads) -----------------

const delegation = await http(
  "GET",
  `${xrpc("com.atproto.space.getDelegationToken")}?${new URLSearchParams({ space })}`,
  { headers: bearer },
);
if (!delegation.token) throw new Error("getDelegationToken returned no token");
report("space.getDelegationToken", `${delegation.token.length}-byte grant`);

const key = generateKeyPairSync("ec", { namedCurve: "P-256" });
const credentialUrl = xrpc("com.atproto.space.getSpaceCredential");
const minted = await http("POST", credentialUrl, {
  headers: {
    authorization: `Bearer ${delegation.token}`,
    dpop: dpopProof({ method: "POST", url: credentialUrl, key }),
  },
  body: { space },
});
if (!minted.credential) throw new Error("getSpaceCredential returned no credential");
report("space.getSpaceCredential", `${minted.credential.length}-byte credential`);

// Space credentials travel under the DPoP scheme, never Bearer, and every read
// carries a proof bound to the credential via `ath`.
async function spaceRead(nsid, params) {
  const url = `${xrpc(nsid)}?${new URLSearchParams(params)}`;
  return http("GET", url, {
    headers: {
      authorization: `DPoP ${minted.credential}`,
      dpop: dpopProof({ method: "GET", url, key, accessToken: minted.credential }),
    },
  });
}

const described = await spaceRead("com.atproto.space.getSpace", { space });
report("space.getSpace", `config ${JSON.stringify(described.config)}`);

const secured = await spaceRead("com.atproto.space.listRecords", {
  space,
  repo: did,
  collection: COLLECTION,
});
if (!(secured.records ?? []).some(isOurRecord)) {
  throw new Error("credential-authorised listRecords did not return the record");
}
report("space.listRecords (credential)", `${secured.records.length} record(s)`);

// The credential reads every repo in its space, so it only works under the DPoP
// scheme and only beside a proof from the key it was minted for. Both are
// checked here: no proof at all, and a proof from a different key.
const spaceUrl = `${xrpc("com.atproto.space.getSpace")}?${new URLSearchParams({ space })}`;
const withoutProof = await http("GET", spaceUrl, {
  headers: { authorization: `DPoP ${minted.credential}` },
}).then(
  () => null,
  (error) => error,
);
if (!withoutProof) throw new Error("a credential with no DPoP proof was accepted");
report("space.getSpace without proof", `refused — ${withoutProof.message.split(" -> ")[1]}`);

const otherKey = generateKeyPairSync("ec", { namedCurve: "P-256" });
const wrongKey = await http("GET", spaceUrl, {
  headers: {
    authorization: `DPoP ${minted.credential}`,
    dpop: dpopProof({ method: "GET", url: spaceUrl, key: otherKey, accessToken: minted.credential }),
  },
}).then(
  () => null,
  (error) => error,
);
if (!wrongKey) throw new Error("a credential was accepted with a proof from another key");
report("space.getSpace with the wrong key", `refused — ${wrongKey.message.split(" -> ")[1]}`);

console.log(`\nspaces ready on ${PDS}`);
console.log(`  space    ${space}`);
console.log(`  record   ${written.uri}`);
