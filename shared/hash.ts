// Portable SHA-256 hex — works in the renderer and the main process alike.
//
// Uses @noble/hashes (already a dependency, already used by the tx builder and
// address derivation) rather than node:crypto, so shared/ code that runs in the
// renderer does not pull a Node built-in it cannot have.

import { sha256 } from '@noble/hashes/sha256';

export function sha256Hex(text: string): string {
  const bytes = sha256(new TextEncoder().encode(text));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex;
}
