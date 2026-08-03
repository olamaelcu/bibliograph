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

export function buildDidDocument(serviceDid: string, serviceEndpoint: string): DidDocument {
  return {
    id: serviceDid,
    service: [
      {
        id: '#atproto_labeler',
        type: 'AtprotoLabeler',
        serviceEndpoint,
      },
    ],
  };
}
