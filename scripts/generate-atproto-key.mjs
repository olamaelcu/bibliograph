import { Secp256k1Keypair } from '@atproto/crypto';

const keypair = await Secp256k1Keypair.create({ exportable: true });

const publicKeyMultibase = keypair.did().replace('did:key:', '');
const privateKeyHex = Buffer.from(await keypair.export()).toString('hex');

console.log('# ATProto signing key (do NOT commit this output)');
console.log('ATP_SERVICE_KEY_MULTIBASE=' + publicKeyMultibase);
console.log('ATP_SIGNING_KEY=' + privateKeyHex);
