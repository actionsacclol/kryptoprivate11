// Minimal `electron` stand-in so wallet.ts can be exercised in node.
//
// The keystore is stubbed with a reversible prefix, NOT real encryption —
// these tests are about bookkeeping (which key is active, what survives a
// restart), not about DPAPI. wallet.ts treats `secretEnc` as opaque either
// way, so the paths under test are the production ones.
import path from 'node:path';

export const app = {
  getPath: () => process.env.KRYPT_TEST_USERDATA ?? path.join(process.cwd(), 'test', '.walletdata'),
};

export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (s) => Buffer.from(`stub:${s}`, 'utf8'),
  decryptString: (buf) => Buffer.from(buf).toString('utf8').replace(/^stub:/, ''),
};

export default { app, safeStorage };
