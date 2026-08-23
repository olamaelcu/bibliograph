#!/usr/bin/env tsx
// Generate an ATProto lex-publisher K-256 keypair.
// Prints ATP_SIGNING_KEY (private, hex) and ATP_SERVICE_KEY_MULTIBASE (public, multibase zQ3s...)
// to stdout. These two values are what get injected into the running app's environment.

import { Secp256k1Keypair, formatMultikey } from '@atproto/crypto';

const HOSTNAME = process.env.LEX_PUBLISHER_HOSTNAME ?? 'biblio.livtet.olamaelcu.net';
const DID = `did:web:${HOSTNAME}`;

async function main(): Promise<void> {
  const kp = await Secp256k1Keypair.create({ exportable: true });
  const privKeyBytes = await kp.export();
  const publicKeyBytes = kp.publicKeyBytes();
  const privateKeyHex = Buffer.from(privKeyBytes).toString('hex');
  const publicKeyMultibase = formatMultikey('ES256K', publicKeyBytes);
  const didKey = kp.did();

  console.log('Lex publisher key generated.\n');
  console.log(`DID: ${DID}`);
  console.log(`did:key (informational): ${didKey}\n`);
  console.log('Add these to infra/ansible/group_vars/all/secrets.sops.yml as top-level keys:\n');
  console.log(`  bibliograph_signing_key: "${privateKeyHex}"`);
  console.log(`  bibliograph_service_key_multibase: "${publicKeyMultibase}"\n`);
  console.log('Then run the Dokku deploy step (or `mise run lex:deploy-secrets`) to inject them.\n');
  console.log('--- for direct env-var injection (DO NOT use in production):');
  console.log(`ATP_SIGNING_KEY=${privateKeyHex}`);
  console.log(`ATP_SERVICE_KEY_MULTIBASE=${publicKeyMultibase}`);
  console.log(`ATP_SERVICE_HOST=${HOSTNAME}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
