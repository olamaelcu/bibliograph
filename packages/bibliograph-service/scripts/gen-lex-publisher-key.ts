#!/usr/bin/env tsx
// Generate an ATProto lex-publisher K-256 keypair.
// Prints ATP_SIGNING_KEY (private, hex) and ATP_SERVICE_KEY_MULTIBASE (public, multibase zQ3s...)
// to stdout. Both halves go into /etc/bibliograph/bibliograph.env on the host,
// which systemd passes to the web and worker units.

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
  console.log('Put both halves in /etc/bibliograph/bibliograph.env (root:root, 0640),');
  console.log('replacing the commented ATP_SIGNING_KEY / ATP_SERVICE_KEY_MULTIBASE lines:\n');
  console.log(`ATP_SIGNING_KEY=${privateKeyHex}`);
  console.log(`ATP_SERVICE_KEY_MULTIBASE=${publicKeyMultibase}\n`);
  console.log(`Set ATP_SERVICE_HOST=${HOSTNAME} only if the conffile default differs.\n`);
  console.log('Then apply it:');
  console.log('  systemctl restart bibliograph   # serves .well-known/did.json from env');
  console.log('  mise run publish-lex            # re-signs the lexicon CARs with this key\n');
  console.log('Both halves are needed: with only ATP_SIGNING_KEY the DID document keeps');
  console.log('serving the placeholder under #atproto. Rotating this key invalidates the');
  console.log('existing CARs (publish-lex fixes that); labels are signed by the separate');
  console.log('label key from scripts/gen-label-key.ts, not by this one.');
  console.log('The private half must never leave this host or reach version control.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
