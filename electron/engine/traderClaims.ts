// Krypto Trader claims on a (wallet, coin) pair — the seam every OTHER
// automation consults before it buys a coin or arms an order on it
// (stage 3, critic #6). Main (electron/ipc.ts) installs the check, which asks
// electron/engine/kryptoTrader.ts `claimOn`; the engine, scripts, copy
// trading and the MCP host only ask this module, so none of them imports the
// Trader engine (no cycle, and each module's test bundle stays small).
//
// What is refused while a LIVE session holds the pair:
//   • buys by scripts (bot.buy, a named-wallet buy, a limit buy), copy
//     trading, and MCP buy_token;
//   • creating an advanced order on the coin in the active wallet — orders
//     sell the ACTIVE wallet's whole balance when they fire, the session's
//     bag included (createOrder covers the Orders panel, templates, MCP
//     place_order and script orders alike).
// What is NOT refused, on purpose:
//   • the user's manual buy/sell buttons — never blocked;
//   • SELLS that act on the active wallet's whole balance (the engine's own
//     auto-exit `autoLiveSell` '100%', an already-armed order firing, the
//     panic "sell everything" `sellAllHeld`). Those are the user's exits and
//     an exit is never blocked (order-safety rule 2). They are caught after
//     the fact instead: the fill lands in the ledger, `onLedgerFill` sees a
//     trade on the pair that is not the session's, pauses the session and
//     shrinks its claim to what the wallet still holds (T23).
//
// On BNB and Robinhood Chain (stage 4) the same seam covers EVM script buys
// (automation buyGate and engine.hostBuy's EVM branch), EVM copy buys and
// MCP buy_token on an EVM chain — each passes its `chain`.

import type { ChainKind } from '@shared/chainKind';

/**
 * `walletId` null = the ACTIVE wallet (what orders, scripts' bot.buy and MCP
 * buy_token trade from) — on an EVM chain, THAT chain's signer. `chain`
 * absent = Solana. A claim is (chain, wallet, coin): the same 0x wallet and
 * token on BNB and on Robinhood are two pairs (stage 4).
 */
export interface TraderClaimRef {
  walletId?: string | null;
  address?: string | null;
  chain?: ChainKind;
}
export type TraderClaimCheck = (ref: TraderClaimRef, mint: string) => string | null;

let check: TraderClaimCheck | null = null;

export function setTraderClaimCheck(fn: TraderClaimCheck | null): void {
  check = fn;
}

/**
 * The refusal when a live Krypto Trader session holds this coin in this
 * wallet, else null. A check that throws REFUSES (unknown never permits):
 * everything that consults this is automation or an order, never the user's
 * own buy/sell button.
 */
export function traderClaimFor(ref: TraderClaimRef, mint: string): string | null {
  if (!check || !mint) return null;
  try {
    return check(ref, mint);
  } catch (e) {
    return `could not check Krypto Trader sessions for this coin (${(e as Error).message}) — refused to be safe`;
  }
}
