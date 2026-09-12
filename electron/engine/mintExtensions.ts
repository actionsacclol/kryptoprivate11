// Token-2022 mint extensions — the bytes that tell a spam airdrop from a coin.
//
// Why (2026-09-07): a user tried to sell `GNhCph…pump`. Every route refused
// it — no bonding curve, Jupiter "not tradable", relayer 400 — and the app
// could only say so three times over. The token was never a pump.fun coin:
// a Token-2022 mint with a vanity `pump` suffix, a 3.96M supply, a
// PermanentDelegate (the issuer can pull it out of any wallet) and a name
// that is an advertisement. It had been airdropped. A wallet full of these
// shows every one as a "previous run" holding with a Sell button.
//
// The mint account says all of this up front, so the holdings list and the
// sell failure can name it instead of guessing. Pure parsing; the caller
// fetches the bytes.

import { base58Encode } from './base58';

/** Token-2022 extension type ids (spl-token-2022 `ExtensionType`). */
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;
const EXT_TOKEN_METADATA = 19;

/** Base mint layout (82 bytes) padded to the account-type byte at 165. */
const MINT_BASE_LEN = 82;
const ACCOUNT_TYPE_OFFSET = 165;
const ACCOUNT_TYPE_MINT = 1;

export interface MintExtensions {
  /** Someone other than the holder can move or burn the tokens at will. */
  permanentDelegate: string | null;
  /** Transfers are forbidden outright — cannot be sold to anyone. */
  nonTransferable: boolean;
  /** A program runs on every transfer (fees, blocks, tracking). */
  transferHook: string | null;
  /** Basis points taken from EVERY transfer, including your sell. Null when
   *  the mint has no transfer-fee extension. 10000 bp = the whole amount. */
  transferFeeBps: number | null;
  /** New token accounts are created FROZEN, so a buyer may be unable to sell
   *  until the freeze authority thaws them one by one. */
  defaultFrozen: boolean;
  /** On-chain metadata, when the mint carries it. */
  name: string | null;
  symbol: string | null;
}

/**
 * Parse the extension TLV of a Token-2022 mint account. Returns null for a
 * plain SPL mint (82 bytes) or anything that is not a mint. Never throws:
 * a malformed tail simply stops the walk.
 */
export function parseMintExtensions(data: Uint8Array): MintExtensions | null {
  const d = Buffer.from(data);
  if (d.length <= ACCOUNT_TYPE_OFFSET) return d.length === MINT_BASE_LEN ? { permanentDelegate: null, nonTransferable: false, transferHook: null, transferFeeBps: null, defaultFrozen: false, name: null, symbol: null } : null;
  if (d[ACCOUNT_TYPE_OFFSET] !== ACCOUNT_TYPE_MINT) return null;
  const out: MintExtensions = { permanentDelegate: null, nonTransferable: false, transferHook: null, transferFeeBps: null, defaultFrozen: false, name: null, symbol: null };
  let off = ACCOUNT_TYPE_OFFSET + 1;
  while (off + 4 <= d.length) {
    const type = d.readUInt16LE(off);
    const len = d.readUInt16LE(off + 2);
    const body = d.subarray(off + 4, off + 4 + len);
    if (body.length < len) break;
    switch (type) {
      // TransferFeeConfig: … newer_transfer_fee at the tail, whose last two
      // fields are maximum_fee (u64) and transfer_fee_basis_points (u16).
      // Read from the END so a layout that grows at the front still parses.
      case EXT_TRANSFER_FEE_CONFIG:
        if (len >= 2) out.transferFeeBps = body.readUInt16LE(body.length - 2);
        break;
      // 1 = Initialized (normal), 2 = Frozen.
      case EXT_DEFAULT_ACCOUNT_STATE:
        if (len >= 1 && body[0] === 2) out.defaultFrozen = true;
        break;
      case EXT_PERMANENT_DELEGATE:
        if (len >= 32) out.permanentDelegate = base58Encode(body.subarray(0, 32));
        break;
      case EXT_NON_TRANSFERABLE:
        out.nonTransferable = true;
        break;
      case EXT_TRANSFER_HOOK:
        if (len >= 64) {
          const program = body.subarray(32, 64);
          if (!program.every((b) => b === 0)) out.transferHook = base58Encode(program);
        }
        break;
      case EXT_TOKEN_METADATA: {
        // update_authority 32 · mint 32 · name (u32 len + bytes) · symbol · uri
        let p = 64;
        const str = (): string | null => {
          if (p + 4 > body.length) return null;
          const n = body.readUInt32LE(p);
          if (p + 4 + n > body.length) return null;
          const s = body.subarray(p + 4, p + 4 + n).toString('utf8');
          p += 4 + n;
          return s;
        };
        out.name = str();
        out.symbol = str();
        break;
      }
      default:
        break;
    }
    off += 4 + len;
  }
  return out;
}

/**
 * One line for the user when a holding looks like something that was put in
 * the wallet rather than bought — or cannot leave it. Null when the mint
 * carries nothing suspicious. Cheap to show; the trade path still decides.
 */
export function mintWarning(ext: MintExtensions | null): string | null {
  if (!ext) return null;
  if (ext.nonTransferable) return 'non-transferable token — it cannot be sold or sent';
  if (ext.permanentDelegate) {
    return 'Token-2022 with a permanent delegate: the issuer can move it out of your wallet at will — typical of a spam airdrop, not a pump.fun coin';
  }
  if (ext.defaultFrozen) return 'Token-2022 that freezes new accounts by default — you may not be able to sell until the issuer thaws yours';
  // Ordered above the transfer hook because a fee is a KNOWN, quantified loss
  // on every sell, where a hook is a maybe. The automation path (risk.ts) has
  // refused both since it was written; until 2026-09-09 the user-facing
  // parser did not read either, so a token that taxes every transfer warned
  // the bot and told the person nothing.
  if (ext.transferFeeBps !== null && ext.transferFeeBps > 0) {
    const pct = ext.transferFeeBps / 100;
    return ext.transferFeeBps >= 10_000
      ? 'Token-2022 that takes 100% of every transfer — it cannot be sold for anything'
      : `Token-2022 with a ${pct}% fee on every transfer — that comes off your sell as well as your buy`;
  }
  if (ext.transferHook) return 'Token-2022 with a transfer hook — a program runs on every transfer and may block or tax it';
  return null;
}
