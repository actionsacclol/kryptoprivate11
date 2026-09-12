// pump.fun `create_v2` — the one instruction that makes a new token.
//
// Every account below was read out of pump's own on-chain Anchor IDL and then
// CHECKED: derive all sixteen for three real launches and compare to what the
// creator actually submitted. All sixteen matched on all three. The fixture
// test (test/pumplaunch.test.mjs) keeps that true.
//
// That mattered because the account list is not guessable. Six of the sixteen
// belong to pump's MAYHEM program rather than to pump itself — including two
// (`mayhem_state`, `mayhem_token_vault`) that no amount of reading pump's own
// seeds would have produced. A create with two wrong accounts is a transaction
// that fails, or lands and does something the user did not ask for.
//
// ─── The second signer ───────────────────────────────────────────────────
//
// Slot 0 is the new mint, and it SIGNS. That is the whole reason the signer
// needed a launch intent: see signPolicy.checkLaunchSigners, which requires
// exactly two signatures and refuses unless slot 1 of the message is the
// ephemeral mint this app generated for this launch.

import { PublicKey, TransactionInstruction, type AccountMeta } from '@solana/web3.js';

/** pump.fun. */
export const PUMP_PROGRAM = new PublicKey('6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P');
/**
 * pump's MAYHEM program — six of create_v2's accounts live under it.
 *
 * The app already knew mayhem existed (txBuilder reads `is_mayhem_mode` off
 * the curve to pick a fee recipient); this is the same machinery on the create
 * side.
 */
export const MAYHEM_PROGRAM = new PublicKey('MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e');

const TOKEN_2022 = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA_PROGRAM = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

/** sha256("global:create_v2")[0..8], and the discriminator seen on chain. */
export const CREATE_V2_DISCRIMINATOR = Buffer.from('d6904cec5f8b31b4', 'hex');

const pda = (seeds: Buffer[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

/** Associated token account, Token-2022. pump creates in Token-2022 now. */
const ata = (owner: PublicKey, mint: PublicKey): PublicKey =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

export const bondingCurveOf = (mint: PublicKey): PublicKey => pda([Buffer.from('bonding-curve'), mint.toBuffer()], PUMP_PROGRAM);
export const solVault = (): PublicKey => pda([Buffer.from('sol-vault')], MAYHEM_PROGRAM);
export const mayhemStateOf = (mint: PublicKey): PublicKey => pda([Buffer.from('mayhem-state'), mint.toBuffer()], MAYHEM_PROGRAM);

/**
 * create_v2's sixteen accounts, in order.
 *
 * Verified against real launches 2026-09-10. The order is the IDL's and must
 * not be rearranged: Anchor matches by position, not by name.
 */
export function createV2Accounts(mint: PublicKey, creator: PublicKey): AccountMeta[] {
  const curve = bondingCurveOf(mint);
  const vault = solVault();
  const ro = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: false });
  const w = (pubkey: PublicKey): AccountMeta => ({ pubkey, isSigner: false, isWritable: true });
  return [
    { pubkey: mint, isSigner: true, isWritable: true }, //  0 mint — SIGNS for itself
    ro(pda([Buffer.from('mint-authority')], PUMP_PROGRAM)), //  1 mint_authority
    w(curve), //  2 bonding_curve
    w(ata(curve, mint)), //  3 associated_bonding_curve
    ro(pda([Buffer.from('global')], PUMP_PROGRAM)), //  4 global
    { pubkey: creator, isSigner: true, isWritable: true }, //  5 user — fee payer
    ro(SYSTEM_PROGRAM), //  6 system_program
    ro(TOKEN_2022), //  7 token_program
    ro(ATA_PROGRAM), //  8 associated_token_program
    w(MAYHEM_PROGRAM), //  9 mayhem_program_id
    ro(pda([Buffer.from('global-params')], MAYHEM_PROGRAM)), // 10 global_params
    w(vault), // 11 sol_vault
    w(mayhemStateOf(mint)), // 12 mayhem_state
    w(ata(vault, mint)), // 13 mayhem_token_vault — the sol_vault's ATA
    ro(pda([Buffer.from('__event_authority')], PUMP_PROGRAM)), // 14 event_authority
    ro(PUMP_PROGRAM), // 15 program
  ];
}

export interface CreateV2Args {
  name: string;
  symbol: string;
  /** Metadata URI. A free string — pump does not host it and neither do we. */
  uri: string;
  /** Credited as the creator, and paid the creator fee. */
  creator: PublicKey;
  /**
   * Mayhem mode: the coin trades against inflated virtual reserves and its fee
   * goes to a RESERVED recipient. The app decodes this on the trade side
   * already; launching one is opt-in and off unless asked for.
   */
  mayhem: boolean;
  /**
   * Cashback: the creator's whole fee is redirected to traders, permanently.
   * `null` leaves it unset. Measured 2026-09-09: 44% of new pump launches use
   * it, and it is why the modal successful launch pays its creator nothing.
   */
  cashback: boolean | null;
}

const borshString = (s: string): Buffer => {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([len, b]);
};

/**
 * `OptionBool` is NOT an Option.
 *
 * The IDL defines it as `struct { bool }` — a single byte, no tag. Encoding it
 * as an Anchor Option would add a discriminant byte and shift everything after
 * it, which is the sort of mistake that produces a transaction the program
 * rejects for reasons that look nothing like the cause.
 */
const optionBool = (v: boolean | null): Buffer => Buffer.from([v ? 1 : 0]);

/**
 * Eight zero bytes every real create carries and the IDL does not describe.
 *
 * Measured on three launches 2026-09-10: the on-chain instruction data is
 * exactly eight bytes longer than the published argument list accounts for,
 * and those bytes are zero every time. The on-chain IDL is evidently a little
 * behind the deployed program.
 *
 * We send what everyone else sends. It is written down here rather than
 * silently appended so that the day it stops being zero, this comment is where
 * someone looks — and the fixture test fails first.
 */
const UNDOCUMENTED_TAIL = Buffer.alloc(8);

/** create_v2's argument buffer, Borsh, in IDL order. */
export function createV2Data(args: CreateV2Args): Buffer {
  return Buffer.concat([
    CREATE_V2_DISCRIMINATOR,
    borshString(args.name),
    borshString(args.symbol),
    borshString(args.uri),
    args.creator.toBuffer(),
    Buffer.from([args.mayhem ? 1 : 0]),
    optionBool(args.cashback),
    UNDOCUMENTED_TAIL,
  ]);
}

/** The whole instruction: accounts in IDL order, Borsh args. */
export function createV2Instruction(mint: PublicKey, args: CreateV2Args): TransactionInstruction {
  return new TransactionInstruction({
    programId: PUMP_PROGRAM,
    keys: createV2Accounts(mint, args.creator),
    data: createV2Data(args),
  });
}
