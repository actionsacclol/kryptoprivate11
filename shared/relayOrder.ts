// Relay's order binding — the far end of a Relay deposit, proved (2026-10-02).
//
// shared/relay.ts says it plainly: the deposit bytes carry no recipient, no
// chain, no amount out — "bound only by Relay's request, behind a hash". This
// module opens the hash. With `includeProtocolData: true` a quote carries
// `protocol.v2.orderData`, the whole settlement order, and Relay's "Input
// Validation" guide (docs.relay.link/references/api/api_core_concepts/
// input-validation) says the 32-byte id the deposit commits to IS that
// order's id: the EIP-712 hashStruct of orderData. So:
//
//   1. read what the order delivers — recipient, chain, currency, floor —
//      and compare it with what was asked (relayOrderProblem);
//   2. recompute the order id from those same fields (relayOrderId);
//   3. require the deposit to commit to exactly that id and to pay exactly
//      the order's input (relayCommitmentProblem).
//
// If all three pass, settlement follows the order that was inspected; an API
// that lies in orderData produces an id the deposit does not carry.
//
// The types and the address encoding are copied from Relay's settlement SDK,
// @relay-protocol/settlement-sdk 0.0.144 (dist/order/index.js:
// ORDER_EIP712_TYPES, normalizeOrder, getOrderId; dist/utils.js:
// encodeAddress, encodeBytesToHex). The SDK itself is not a dependency — it
// pulls in tronweb, TON and bitcoinjs for chains this app never touches.
// Recomputed against live quotes on all four routes (fixtures:
// test/fixtures/relay-orders.json).
//
// Pure: no network, no clock unless one is passed, plain error strings.

import { hashStruct, type Hex } from 'viem';
import type { BridgeChain } from './bridge';
import {
  RELAY_CHAIN_ID,
  RELAY_NATIVE,
  RELAY_SOLANA_DEPOSITORY,
  RELAY_DEPOSIT_NATIVE_DISC,
  RELAY_EVM_DEPOSITORY,
  RELAY_EVM_DEPOSIT_SELECTOR,
} from './relay';

/**
 * The settlement protocol's own chain names — NOT the /chains API's `name`
 * (that calls BNB "bsc"; the protocol calls it "bnb"). Read off GET /chains
 * `protocol.v2.chainId` and off live orders, 2026-10-02. An order naming any
 * other chain is refused: a route nobody has looked at.
 */
export const RELAY_PROTOCOL_CHAIN: Record<BridgeChain, string> = {
  solana: 'solana',
  bnb: 'bnb',
  robinhood: 'robinhood',
};

type Vm = 'solana-vm' | 'ethereum-vm';
const VM_OF: Record<string, { chain: BridgeChain; vm: Vm }> = {
  [RELAY_PROTOCOL_CHAIN.solana]: { chain: 'solana', vm: 'solana-vm' },
  [RELAY_PROTOCOL_CHAIN.bnb]: { chain: 'bnb', vm: 'ethereum-vm' },
  [RELAY_PROTOCOL_CHAIN.robinhood]: { chain: 'robinhood', vm: 'ethereum-vm' },
};

/** The protocol's name for a Relay chain id (792703809, 56, 4663), or null. */
export function relayProtocolChainOf(relayChainId: number): string | null {
  for (const c of Object.keys(RELAY_CHAIN_ID) as BridgeChain[]) {
    if (RELAY_CHAIN_ID[c] === relayChainId) return RELAY_PROTOCOL_CHAIN[c];
  }
  return null;
}

/**
 * The settlement SDK's ORDER_EIP712_TYPES (order version "v1"), verbatim.
 * There is no domain: the id is hashStruct, not hashTypedData.
 */
export const RELAY_ORDER_EIP712_TYPES = {
  Order: [
    { name: 'version', type: 'string' },
    { name: 'solverChainId', type: 'string' },
    { name: 'solver', type: 'address' },
    { name: 'salt', type: 'uint256' },
    { name: 'inputs', type: 'Input[]' },
    { name: 'output', type: 'Output' },
    { name: 'fees', type: 'Fee[]' },
  ],
  Input: [
    { name: 'payment', type: 'InputPayment' },
    { name: 'refunds', type: 'InputRefund[]' },
  ],
  InputPayment: [
    { name: 'chainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
    { name: 'weight', type: 'uint256' },
  ],
  InputRefund: [
    { name: 'chainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'deadline', type: 'uint32' },
    { name: 'extraData', type: 'bytes' },
  ],
  Output: [
    { name: 'chainId', type: 'string' },
    { name: 'payments', type: 'OutputPayment[]' },
    { name: 'deadline', type: 'uint32' },
    { name: 'calls', type: 'bytes[]' },
    { name: 'extraData', type: 'bytes' },
  ],
  OutputPayment: [
    { name: 'recipient', type: 'bytes' },
    { name: 'currency', type: 'bytes' },
    { name: 'minimumAmount', type: 'uint256' },
    { name: 'expectedAmount', type: 'uint256' },
  ],
  Fee: [
    { name: 'recipientChainId', type: 'string' },
    { name: 'recipient', type: 'bytes' },
    { name: 'currencyChainId', type: 'string' },
    { name: 'currency', type: 'bytes' },
    { name: 'amount', type: 'uint256' },
  ],
} as const;

/** `protocol.v2.orderData` as Relay sends it (order version "v1"). */
export interface RelayOrderData {
  version: 'v1';
  solverChainId: string;
  solver: string;
  salt: string;
  inputs: Array<{
    payment: { chainId: string; currency: string; amount: string; weight: string };
    refunds: Array<{ chainId: string; recipient: string; currency: string; minimumAmount: string; deadline: number; extraData: string }>;
  }>;
  output: {
    chainId: string;
    payments: Array<{ recipient: string; currency: string; minimumAmount: string; expectedAmount: string }>;
    calls: string[];
    deadline: number;
    extraData: string;
  };
  fees: Array<{ recipientChainId: string; recipient: string; currencyChainId: string; currency: string; amount: string }>;
}

/** What the order must deliver. Read from the app's own state, never from the quote. */
export interface RelayOrderExpect {
  /** Our own address on the destination chain. */
  recipient: string;
  /** Relay's chain id of the destination (792703809, 56, 4663). */
  destinationChainId: number;
  /** The coin that must arrive — RELAY_NATIVE[to] for every route this app runs. */
  destinationCurrency: string;
  /** The least the order may guarantee, in destination base units. */
  minOutRaw?: bigint;
  /** When given, every refund the order names must go to one of these (our own addresses). */
  refundRecipients?: string[];
  /** When given (unix seconds), the order must not have expired. */
  nowSec?: number;
}

// ── encoding, as the settlement SDK does it ───────────────────────────────

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Base58 to bytes (leading '1's are leading zero bytes), or null. */
function base58ToBytes(s: string): Uint8Array | null {
  if (!s || s.length > 64) return null;
  let n = 0n;
  for (const ch of s) {
    const i = B58.indexOf(ch);
    if (i < 0) return null;
    n = n * 58n + BigInt(i);
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

/** An address as the bytes the order hashes (SDK encodeAddress), or null. */
function encodeAddress(address: unknown, vm: Vm): Hex | null {
  if (typeof address !== 'string') return null;
  if (vm === 'ethereum-vm') return /^0x[0-9a-fA-F]{40}$/.test(address) ? (address.toLowerCase() as Hex) : null;
  const b = base58ToBytes(address);
  return b && b.length === 32 ? toHex(b) : null;
}

/** A `bytes` field (SDK encodeBytesToHex), or null. */
function encodeBytes(v: unknown): Hex | null {
  return typeof v === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(v) ? (v.toLowerCase() as Hex) : null;
}

const MAX_U256 = (1n << 256n) - 1n;

function uint256(v: unknown): bigint | null {
  let n: bigint;
  if (typeof v === 'string' && /^(?:\d{1,78}|0x[0-9a-fA-F]{1,64})$/.test(v)) n = BigInt(v);
  else if (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) n = BigInt(v);
  else return null;
  return n <= MAX_U256 ? n : null;
}

function uint32(v: unknown): number | null {
  const n = typeof v === 'string' && /^\d{1,10}$/.test(v) ? Number(v) : v;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff ? n : null;
}

const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);
const obj = (v: unknown): Record<string, any> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : null);

class OrderUnreadable extends Error {}
const fail = (why: string): never => {
  throw new OrderUnreadable(why);
};

/** The chain an order field names, or why the order is refused. */
function vmOf(chainId: unknown): Vm {
  if (typeof chainId !== 'string') return fail('the order names a chain without a name');
  const c = VM_OF[chainId];
  if (!c) return fail(`the order names chain "${chainId.slice(0, 24)}", which this app does not bridge`);
  return c.vm;
}

function addr(v: unknown, vm: Vm, what: string): Hex {
  return encodeAddress(v, vm) ?? fail(`the order's ${what} is not ${vm === 'solana-vm' ? 'a Solana' : 'an EVM'} address`);
}
function bytes(v: unknown, what: string): Hex {
  return encodeBytes(v) ?? fail(`the order's ${what} is not hex bytes`);
}
function u256(v: unknown, what: string): bigint {
  return uint256(v) ?? fail(`the order's ${what} is not a whole number`);
}
function u32(v: unknown, what: string): number {
  return uint32(v) ?? fail(`the order's ${what} is not a 32-bit time`);
}

/** orderData, normalised the way the SDK's normalizeOrder does — every field read, every type checked. */
function normalize(raw: unknown) {
  const o = obj(raw) ?? fail('the quote carries no order');
  if (o.version !== 'v1') return fail(`the order is version ${String(o.version).slice(0, 12)}, not the measured v1`);
  if (typeof o.solverChainId !== 'string') return fail("the order's solver chain is missing");
  if (typeof o.solver !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(o.solver)) return fail("the order's solver is not an address");
  const out = obj(o.output) ?? fail('the order has no output');
  const outVm = vmOf(out.chainId);
  return {
    version: o.version as string,
    solverChainId: o.solverChainId as string,
    // Lower case: the hash is over the 20 bytes, and viem refuses a bad checksum.
    solver: o.solver.toLowerCase() as Hex,
    salt: u256(o.salt, 'salt'),
    inputs: (arr(o.inputs) ?? fail('the order has no inputs')).map((rawIn) => {
      const input = obj(rawIn) ?? fail('an order input is unreadable');
      const p = obj(input.payment) ?? fail('an order input has no payment');
      const pVm = vmOf(p.chainId);
      return {
        payment: {
          chainId: p.chainId as string,
          currency: addr(p.currency, pVm, 'input currency'),
          amount: u256(p.amount, 'input amount'),
          weight: u256(p.weight, 'input weight'),
        },
        refunds: (arr(input.refunds) ?? fail('an order input has no refund list')).map((rawR) => {
          const r = obj(rawR) ?? fail('an order refund is unreadable');
          const rVm = vmOf(r.chainId);
          return {
            chainId: r.chainId as string,
            recipient: addr(r.recipient, rVm, 'refund recipient'),
            currency: addr(r.currency, rVm, 'refund currency'),
            minimumAmount: u256(r.minimumAmount, 'refund minimum'),
            deadline: u32(r.deadline, 'refund deadline'),
            extraData: bytes(r.extraData, 'refund extra data'),
          };
        }),
      };
    }),
    output: {
      chainId: out.chainId as string,
      payments: (arr(out.payments) ?? fail('the order has no output payments')).map((rawP) => {
        const p = obj(rawP) ?? fail('an output payment is unreadable');
        return {
          recipient: addr(p.recipient, outVm, 'recipient'),
          currency: addr(p.currency, outVm, 'output currency'),
          minimumAmount: u256(p.minimumAmount, 'minimum output'),
          expectedAmount: u256(p.expectedAmount, 'expected output'),
        };
      }),
      deadline: u32(out.deadline, 'deadline'),
      calls: (arr(out.calls) ?? fail('the order has no call list')).map((c) => bytes(c, 'call')),
      extraData: bytes(out.extraData, 'extra data'),
    },
    fees: (arr(o.fees) ?? fail('the order has no fee list')).map((rawF) => {
      const f = obj(rawF) ?? fail('an order fee is unreadable');
      return {
        recipientChainId: f.recipientChainId as string,
        recipient: addr(f.recipient, vmOf(f.recipientChainId), 'fee recipient'),
        currencyChainId: f.currencyChainId as string,
        currency: addr(f.currency, vmOf(f.currencyChainId), 'fee currency'),
        amount: u256(f.amount, 'fee amount'),
      };
    }),
  };
}
type Normalized = ReturnType<typeof normalize>;

function tryNormalize(raw: unknown): { ok: true; order: Normalized } | { ok: false; why: string } {
  try {
    return { ok: true, order: normalize(raw) };
  } catch (e) {
    if (e instanceof OrderUnreadable) return { ok: false, why: e.message };
    return { ok: false, why: 'the order cannot be read' };
  }
}

function hashOrder(order: Normalized): Hex {
  return hashStruct({ types: RELAY_ORDER_EIP712_TYPES, primaryType: 'Order', data: order }).toLowerCase() as Hex;
}

/**
 * The order id — the settlement SDK's getOrderId: hashStruct of the
 * normalised order under RELAY_ORDER_EIP712_TYPES, lower-case hex. Throws a
 * plain-worded Error on an order it cannot read (unknown chain, a malformed
 * address or number); the *Problem functions below never throw.
 */
export function relayOrderId(orderData: RelayOrderData | unknown): Hex {
  const r = tryNormalize(orderData);
  if (!r.ok) throw new Error(r.why);
  return hashOrder(r.order);
}

/** `protocol.v2.orderData` from a raw quote response, or undefined. */
const orderDataOf = (quoteJson: unknown): unknown => obj(obj(obj(quoteJson)?.protocol)?.v2)?.orderData;

const short = (s: string): string => (s.length > 12 ? `${s.slice(0, 8)}…` : s);

/**
 * Why the order inside this quote does not deliver what was asked, or null.
 * Reads `protocol.v2.orderData` of the RAW response (the quote must have been
 * asked with `includeProtocolData: true`) and checks, in the order's own
 * encoding (the bytes the id commits to):
 *   - one input, one output payment, no destination calls, no order fees —
 *     the only shape measured;
 *   - the output chain is `destinationChainId`;
 *   - the one payment goes to `recipient`, in `destinationCurrency`;
 *   - its minimumAmount (the floor settlement enforces — not expectedAmount)
 *     is above zero and at least `minOutRaw`;
 *   - optionally, every refund goes to one of `refundRecipients`, and the
 *     order has not expired at `nowSec`.
 * These checks only mean something together with relayCommitmentProblem,
 * which binds the deposit to this very order.
 */
export function relayOrderProblem(quoteJson: unknown, expect: RelayOrderExpect): string | null {
  const data = orderDataOf(quoteJson);
  if (data === undefined) return "Relay's quote carries no order (protocol data missing)";
  const r = tryNormalize(data);
  if (!r.ok) return r.why;
  const o = r.order;

  if (o.inputs.length !== 1) return `the order has ${o.inputs.length} inputs; the measured order has one`;
  if (o.output.payments.length !== 1) return `the order pays ${o.output.payments.length} recipients; the measured order pays one`;
  if (o.output.calls.length !== 0) return 'the order runs calls on the destination chain; a plain transfer runs none';
  if (o.fees.length !== 0) return 'the order pays fees to other addresses; this app asks for none';

  const wantChain = relayProtocolChainOf(expect.destinationChainId);
  if (!wantChain) return `chain ${expect.destinationChainId} is not one this app bridges to`;
  if (o.output.chainId !== wantChain) return `the order delivers on ${o.output.chainId}, not ${wantChain}`;
  const vm = VM_OF[wantChain].vm;

  const pay = o.output.payments[0];
  const rawPay = (data as RelayOrderData).output.payments[0];
  const wantRecipient = encodeAddress(expect.recipient, vm);
  if (!wantRecipient) return `${short(expect.recipient)} is not an address on ${wantChain}`;
  if (pay.recipient !== wantRecipient) return `the order delivers to ${short(String(rawPay.recipient))}, not your address`;
  const wantCurrency = encodeAddress(expect.destinationCurrency, vm);
  if (!wantCurrency) return `${short(expect.destinationCurrency)} is not a currency on ${wantChain}`;
  if (pay.currency !== wantCurrency) return `the order delivers ${short(String(rawPay.currency))}, not the coin asked for`;

  if (pay.minimumAmount === 0n) return 'the order guarantees nothing (minimum output 0)';
  if (expect.minOutRaw !== undefined && pay.minimumAmount < expect.minOutRaw) {
    return `the order guarantees ${pay.minimumAmount}, less than the ${expect.minOutRaw} shown`;
  }

  if (expect.refundRecipients) {
    for (const ref of o.inputs[0].refunds) {
      const rvm = VM_OF[ref.chainId].vm;
      const ours = expect.refundRecipients.some((a) => encodeAddress(a, rvm) === ref.recipient);
      if (!ours) return `the order refunds to an address on ${ref.chainId} that is not yours`;
    }
  }
  if (expect.nowSec !== undefined && o.output.deadline <= expect.nowSec) return 'the order has expired';
  return null;
}

/** The single deposit item of a raw quote, as parseRelayQuote accepts it, or null. */
function depositItem(quoteJson: unknown): Record<string, any> | null {
  const steps = arr(obj(quoteJson)?.steps);
  if (!steps || steps.length !== 1) return null;
  const step = obj(steps[0]);
  if (step?.id !== 'deposit' || step?.kind !== 'transaction') return null;
  const items = arr(step.items);
  if (!items || items.length !== 1) return null;
  return obj(obj(items[0])?.data);
}

interface Deposit {
  commitment: Hex;
  /** The protocol chain name of the paying chain, or null if the quote's EVM chain id is not ours. */
  chain: string | null;
  amount: bigint;
}

function readDeposit(quoteJson: unknown): Deposit | null {
  const d = depositItem(quoteJson);
  if (!d) return null;
  if (Array.isArray(d.instructions)) {
    if (d.instructions.length !== 1) return null;
    const ix = obj(d.instructions[0]);
    if (ix?.programId !== RELAY_SOLANA_DEPOSITORY || typeof ix.data !== 'string') return null;
    const hex = ix.data.toLowerCase();
    // 8 discriminator + 8 amount (u64 LE) + 32 commitment.
    if (!/^[0-9a-f]{96}$/.test(hex) || !hex.startsWith(RELAY_DEPOSIT_NATIVE_DISC)) return null;
    let amount = 0n;
    for (let i = 7; i >= 0; i--) amount = (amount << 8n) | BigInt(parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16));
    return { commitment: `0x${hex.slice(32)}`, chain: RELAY_PROTOCOL_CHAIN.solana, amount };
  }
  if (typeof d.to === 'string' && typeof d.data === 'string') {
    const data = d.data.toLowerCase();
    // selector + depositor word + id word.
    if (d.to.toLowerCase() !== RELAY_EVM_DEPOSITORY) return null;
    if (!/^0x[0-9a-f]{136}$/.test(data) || !data.startsWith(RELAY_EVM_DEPOSIT_SELECTOR)) return null;
    const value = uint256(typeof d.value === 'number' ? String(d.value) : d.value);
    if (value === null) return null;
    const chainId = typeof d.chainId === 'number' ? d.chainId : Number(d.chainId);
    const chain = relayProtocolChainOf(chainId);
    return { commitment: `0x${data.slice(74)}`, chain: chain === RELAY_PROTOCOL_CHAIN.solana ? null : chain, amount: value };
  }
  return null;
}

/**
 * The 32-byte id the deposit commits to, lower-case hex, or null when the
 * quote's deposit is not the measured one: Solana — one DepositNative
 * instruction to the pinned depository, 48 data bytes, id = bytes 16..48;
 * EVM — depositNative(address, bytes32) to the pinned depository, id = the
 * last calldata word.
 */
export function relayDepositCommitment(quoteJson: unknown): Hex | null {
  return readDeposit(quoteJson)?.commitment ?? null;
}

/**
 * Why the deposit is NOT bound to the order in this quote, or null. The
 * deposit must commit to the id recomputed here from orderData (never the
 * quote's own `orderId` field), and — because the id does not cover what the
 * transaction moves — pay exactly the order's one input: on the input's
 * chain, in its native coin, exactly `payment.amount`.
 */
export function relayCommitmentProblem(quoteJson: unknown): string | null {
  const dep = readDeposit(quoteJson);
  if (!dep) return 'the deposit carries no commitment this app can read';
  const data = orderDataOf(quoteJson);
  if (data === undefined) return "Relay's quote carries no order (protocol data missing)";
  const r = tryNormalize(data);
  if (!r.ok) return r.why;
  const id = hashOrder(r.order);
  if (dep.commitment !== id) return `the deposit commits to order ${dep.commitment.slice(0, 10)}…, not the order the quote describes (${id.slice(0, 10)}…)`;

  if (r.order.inputs.length !== 1) return `the order has ${r.order.inputs.length} inputs; the measured order has one`;
  const pay = r.order.inputs[0].payment;
  if (!dep.chain || pay.chainId !== dep.chain) return `the order is paid on ${pay.chainId}, not the chain the deposit is on`;
  const native = encodeAddress(RELAY_NATIVE[VM_OF[pay.chainId].chain], VM_OF[pay.chainId].vm);
  if (pay.currency !== native) return "the order is paid in a token, but the deposit sends the chain's native coin";
  if (pay.amount !== dep.amount) return `the deposit moves ${dep.amount}, but the order is paid ${pay.amount}`;
  return null;
}

/**
 * Both checks: the order delivers what was asked, and the deposit commits to
 * that order and pays its input. Null means the far end of this deposit is
 * the one inspected — the only Relay binding this app can prove before
 * signing. It does not prove Relay will fill.
 */
export function relayBindingProblem(quoteJson: unknown, expect: RelayOrderExpect): string | null {
  return relayOrderProblem(quoteJson, expect) ?? relayCommitmentProblem(quoteJson);
}
