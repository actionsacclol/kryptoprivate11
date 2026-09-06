// Order-intent state machine — Phase-2 Milestone C foundation, running in
// shadow mode today. One strategy intent → at most one economic position:
// the intent is created and persisted BEFORE any fill, with a
// deterministic id, so the exactly-once discipline exists before the
// first real transaction is ever signed.
//
// Shadow-mode lifecycle: created → policy_validated → persisted →
// filled_paper → reconciled (or policy_rejected). The live path will
// extend this with signed / submitted_unknown / confirmed / … states.

import type { OrderIntent, OrderState } from '@shared/types';
import * as recorder from './recorder';

const intents = new Map<string, OrderIntent>();
const byMint = new Set<string>();

/** Deterministic id: engine session + mint. One entry intent per mint. */
export function intentIdFor(mint: string, sessionStartedAt: number): string {
  return `intent-${sessionStartedAt}-${mint}`;
}

export function hasIntentFor(mint: string): boolean {
  return byMint.has(mint);
}

export function create(mint: string, symbol: string, quoteLamports: bigint, sessionStartedAt: number): OrderIntent | null {
  if (byMint.has(mint)) return null; // exactly-once per mint per session
  const intent: OrderIntent = {
    id: intentIdFor(mint, sessionStartedAt),
    mint,
    symbol,
    side: 'buy',
    quoteLamports: quoteLamports.toString(),
    state: 'created',
    createdAt: Date.now(),
    policyNote: null,
    stateLog: [{ at: Date.now(), state: 'created' }],
  };
  intents.set(intent.id, intent);
  byMint.add(mint);
  recorder.record('order_intent', { id: intent.id, mint, quoteLamports: intent.quoteLamports, state: 'created' });
  return intent;
}

export function transition(intent: OrderIntent, state: OrderState, note?: string): void {
  intent.state = state;
  if (note !== undefined) intent.policyNote = note;
  intent.stateLog.push({ at: Date.now(), state, ...(note !== undefined ? { note } : {}) });
  recorder.record('order_state', { id: intent.id, state, ...(note !== undefined ? { note } : {}) });
}

export function all(): OrderIntent[] {
  return [...intents.values()];
}

export function reset(): void {
  intents.clear();
  byMint.clear();
}
