export interface DidServiceEntry {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export interface DidDocument {
  id: string;
  service: DidServiceEntry[];
}

export function getServiceDid(): string {
  return process.env.ATP_SERVICE_DID ?? 'did:web:localhost';
}

/**
 * Build the DID document for the AppView's service DID.
 *
 * The same DID hosts two AT Protocol roles:
 *
 * - `AtprotoLabeler` — the original label-stream role (subscribeLabels).
 * - `AtprotoPersonalDataServer` — a minimal read-only PDS shim that lets
 *   resolvers fetch records Bibliograph authors under this DID. We do not
 *   implement the full PDS surface (no signing key, MST, write endpoints);
 *   see `src/api/pds.ts` for the four endpoints actually served.
 *
 * Clients that resolve an `at://did:web:biblio.livtet.olamaelcu.net/...`
 * URI will hit whichever service matches the lexicon they're looking for.
 */
export function buildDidDocument(serviceDid: string, serviceEndpoint: string): DidDocument {
  return {
    id: serviceDid,
    service: [
      {
        id: '#atproto_labeler',
        type: 'AtprotoLabeler',
        serviceEndpoint,
      },
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint,
      },
    ],
  };
}
