// DID document for the lex publisher.
//
// The DID advertises a `#atproto_pds` service so the canonical ATProto
// lexicon resolver (`@atcute/lexicon-resolver` → `com.atproto.lexicon.resolveLexicon`
// → `com.atproto.sync.getRecord`) can discover the publisher's PDS endpoint.
//
// For a `did:web` identity, the host serves `https://<host>/.well-known/did.json`.
// The signing key must be the same key used to sign the lex repo commits
// (see `scripts/build-lex-repo.ts`).

const HOSTNAME = process.env.LEX_PUBLISHER_HOSTNAME ?? 'biblio.livtet.olamaelcu.net';
const HANDLE = process.env.LEX_PUBLISHER_HANDLE ?? HOSTNAME;
const DID = process.env.LEX_PUBLISHER_DID ?? `did:web:${HOSTNAME}`;
const PROTO = process.env.LEX_PUBLISHER_PROTO ?? 'https';

const PLACEHOLDER_MULTIBASE = 'z6MkplaceholderDidWebOnlyKeyNotFunctional';

const warnedMissing = new Set<string>();

function publicKeyMultibase(envVar: string, purpose: string): string {
  const key = process.env[envVar];
  if (!key || key === PLACEHOLDER_MULTIBASE) {
    if (!warnedMissing.has(envVar)) {
      warnedMissing.add(envVar);
      console.warn(
        `[did] ${envVar} is not set; serving placeholder publicKeyMultibase. ` +
          `Set ${envVar} to enable verification of ${purpose}.`,
      );
    }
    return PLACEHOLDER_MULTIBASE;
  }
  return key;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  alsoKnownAs: string[];
  verificationMethod: Array<{
    id: string;
    type: string;
    controller: string;
    publicKeyMultibase: string;
  }>;
  service: Array<{
    id: string;
    type: string;
    serviceEndpoint: string;
  }>;
}

export function getDidDocument(): DidDocument {
  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: DID,
    alsoKnownAs: [`at://${HANDLE}`],
    verificationMethod: [
      {
        id: '#atproto',
        type: 'Multikey',
        controller: DID,
        publicKeyMultibase: publicKeyMultibase('ATP_SERVICE_KEY_MULTIBASE', 'lex CAR responses'),
      },
      {
        // Labels are signed by this key (spec: `#atproto_label`). It may hold the
        // same value as `#atproto`, but is kept separate so the labeler key can
        // rotate without touching repository signing.
        id: '#atproto_label',
        type: 'Multikey',
        controller: DID,
        publicKeyMultibase: publicKeyMultibase('ATP_LABEL_KEY_MULTIBASE', 'labels'),
      },
    ],
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: `${PROTO}://${HOSTNAME}`,
      },
      {
        // Labeler service endpoint: origin only, no path segment (per spec).
        id: '#atproto_labeler',
        type: 'AtprotoLabeler',
        serviceEndpoint: `${PROTO}://${HOSTNAME}`,
      },
    ],
  };
}

export const PUBLISHER_DID = DID;
export const PUBLISHER_HOSTNAME = HOSTNAME;
export const PUBLISHER_HANDLE = HANDLE;
