// Token risk engine — the hard rejects from research §3.
//
// Local deterministic checks are authoritative and run without waiting on
// any third-party API. The mint account check is async (one RPC read) and
// lands during the evaluation window; the metadata/structural checks are
// synchronous. Fail-closed: if the mint account can't be read, that is
// itself a flag — the scorer treats unverified safety as zero, not as fine.

import { getAccountInfo } from './rpcClient';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, type PumpCreateEvent } from './pumpDecoder';
import type { RiskFlag } from '@shared/types';

export interface MintSafety {
  checked: boolean;
  flags: RiskFlag[];
}

const flag = (id: string, label: string, hard: boolean): RiskFlag => ({ id, label, hard });

// Control chars, zero-width chars and BOM in a ticker are impersonation tricks.
const HIDDEN_CHARS = new RegExp('[\\u0000-\\u001f\\u200b-\\u200f\\u2060\\ufeff]');

/** Synchronous checks available the instant the create event decodes. */
export function staticChecks(ev: PumpCreateEvent, blacklist: Set<string>): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (blacklist.has(ev.creator)) flags.push(flag('blacklist', 'Creator is blacklisted', true));
  if (!ev.name.trim() || !ev.symbol.trim())
    flags.push(flag('metadata-empty', 'Missing name or symbol', true));
  if (!ev.uri.trim()) flags.push(flag('no-uri', 'No metadata URI', false));
  if (ev.name.length > 64 || ev.symbol.length > 16)
    flags.push(flag('metadata-odd', 'Abnormal metadata lengths', false));
  if (HIDDEN_CHARS.test(ev.name + ev.symbol))
    flags.push(flag('metadata-tricks', 'Hidden characters in name/symbol', true));
  return flags;
}

/**
 * Read the mint account and verify authorities per research §3:
 * reject active freeze authority and any Token-2022 mint outright
 * (unusual extensions are not worth classifying in v1 — reject the class).
 *
 * SPL mint layout: mintAuthorityOption u32 | mintAuthority 32 | supply u64
 * | decimals u8 | isInitialized u8 | freezeAuthorityOption u32 | freezeAuthority 32
 */
export async function checkMint(httpUrl: string, mint: string): Promise<MintSafety> {
  const res = await getAccountInfo(httpUrl, mint);
  if (!res.ok) {
    return { checked: false, flags: [flag('mint-unverified', `Mint not verified (${res.message})`, false)] };
  }
  if (!res.data) {
    // Brand-new accounts can lag `confirmed` briefly; unverified is not safe.
    return { checked: false, flags: [flag('mint-missing', 'Mint account not readable yet', false)] };
  }
  const { owner, data } = res.data;
  const flags: RiskFlag[] = [];
  const isToken2022 = owner === TOKEN_2022_PROGRAM_ID;
  if (!isToken2022 && owner !== TOKEN_PROGRAM_ID) {
    flags.push(flag('bad-owner', `Unknown token program ${owner.slice(0, 8)}…`, true));
    return { checked: true, flags };
  }
  if (data.length < 82) {
    flags.push(flag('bad-layout', 'Malformed mint account layout', true));
    return { checked: true, flags };
  }
  // Base mint fields share the SPL layout for both programs.
  const mintAuthOpt = data.readUInt32LE(0);
  const freezeAuthOpt = data.readUInt32LE(46);
  // Pump keeps mint authority on the bonding curve until completion — an
  // authority is expected pre-graduation, but a *freeze* authority never is.
  if (freezeAuthOpt !== 0) flags.push(flag('freeze-auth', 'Active freeze authority', true));
  if (mintAuthOpt !== 0) flags.push(flag('mint-auth', 'Mint authority active (expected pre-graduation)', false));

  // Token-2022 is now the DEFAULT for Pump create_v2 coins, so we no longer
  // blanket-reject it. Instead we parse the extension TLV and reject only the
  // dangerous extensions (research §3): non-transferable, transfer hook,
  // permanent delegate, transfer fee, default-frozen. Harmless extensions
  // (metadata pointer, token metadata, groups) are allowed.
  if (isToken2022) flags.push(...checkToken2022Extensions(data));
  return { checked: true, flags };
}

// SPL Token-2022 extension type ids (subset we care about).
const EXT_TRANSFER_FEE_CONFIG = 1;
const EXT_DEFAULT_ACCOUNT_STATE = 6;
const EXT_NON_TRANSFERABLE = 9;
const EXT_PERMANENT_DELEGATE = 12;
const EXT_TRANSFER_HOOK = 14;

/** Parse the extension TLV of a Token-2022 mint and flag dangerous ones.
 *  Layout: 82-byte base | pad to 165 | account_type(1) @165 | TLV @166+,
 *  each TLV = type(u16 LE) | length(u16 LE) | data[length]. A plain
 *  Token-2022 mint with no extensions is exactly 82 bytes → no flags. */
function checkToken2022Extensions(data: Buffer): RiskFlag[] {
  const flags: RiskFlag[] = [];
  if (data.length <= 166) return flags; // no extensions
  let off = 166;
  while (off + 4 <= data.length) {
    const type = data.readUInt16LE(off);
    const len = data.readUInt16LE(off + 2);
    off += 4;
    if (off + len > data.length) break;
    const ext = data.subarray(off, off + len);
    switch (type) {
      case EXT_NON_TRANSFERABLE:
        flags.push(flag('non-transferable', 'Non-transferable token (cannot sell)', true));
        break;
      case EXT_TRANSFER_HOOK:
        flags.push(flag('transfer-hook', 'Transfer hook (can block/tax sells)', true));
        break;
      case EXT_PERMANENT_DELEGATE:
        flags.push(flag('permanent-delegate', 'Permanent delegate (tokens can be seized)', true));
        break;
      case EXT_TRANSFER_FEE_CONFIG:
        flags.push(flag('transfer-fee', 'Transfer-fee extension (fee on every trade)', true));
        break;
      case EXT_DEFAULT_ACCOUNT_STATE:
        // state byte: 1 = Initialized (ok), 2 = Frozen (dangerous).
        if (ext.length >= 1 && ext[0] === 2) flags.push(flag('default-frozen', 'Default account state frozen', true));
        break;
      default:
        break; // metadata pointer / token metadata / groups etc. are fine
    }
    off += len;
  }
  return flags;
}

export function hasHardReject(flags: RiskFlag[]): boolean {
  return flags.some((f) => f.hard);
}
