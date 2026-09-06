// Chat-bot authorisation tests.
//
// A bot token is a public endpoint with your name on it: anyone who finds the
// bot can message it. So the rules below are the security boundary, and every
// one of them fails SILENTLY in production if it is wrong — a stranger simply
// starts getting answers about your portfolio.
//
// The invariants:
//   • unpaired, only `/pair <code>` does anything at all;
//   • paired, exactly one sender id is served and everyone else is ignored
//     WITHOUT a reply, because a reply confirms the bot exists;
//   • codes expire and wrong attempts are capped;
//   • no command can trade, by construction.

import assert from 'node:assert';
import {
  COMMANDS,
  HELP_TEXT,
  PAIRING_MAX_ATTEMPTS,
  PAIRING_TTL_MS,
  decide,
  defaultBotSettings,
  isKnownCommand,
  looksLikeToken,
  newPairingCode,
  pairingExpired,
  parseCommand,
  redactToken,
  tryPair,
} from './.bots.mjs';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const NOW = 1_700_000_000_000;
const pairing = (over = {}) => ({ code: '123456', createdAt: NOW, attempts: 0, ...over });

// ── Defaults ──────────────────────────────────────────────────────────

test('bots are OFF and unpaired by default', () => {
  const s = defaultBotSettings();
  for (const k of ['telegram', 'discord']) {
    assert.equal(s[k].enabled, false, `${k} must not be on by default`);
    assert.equal(s[k].token, '');
    assert.equal(s[k].ownerId, null);
  }
});

// ── Pairing ───────────────────────────────────────────────────────────

test('a pairing code is six digits, zero-padded', () => {
  assert.equal(newPairingCode(() => 0), '000000');
  assert.equal(newPairingCode(() => 0.123456), '123456');
  assert.equal(newPairingCode(() => 0.999999), '999999');
  assert.equal(newPairingCode(() => 0.000001).length, 6, 'a small number must still be six digits');
});

test('the right code pairs, and returns the SENDER as owner', () => {
  const p = pairing();
  const r = tryPair(p, '123456', 'sender-42', NOW);
  assert.equal(r.ok, true);
  assert.equal(r.ownerId, 'sender-42', 'the owner is whoever proved they hold the code');
});

test('a wrong code is refused and burns an attempt', () => {
  const p = pairing();
  const r = tryPair(p, '000000', 'attacker', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'wrong-code');
  assert.equal(p.attempts, 1, 'attempts must be counted or the code can be brute-forced');
});

test('attempts are capped, so a six-digit code cannot be brute-forced', () => {
  const p = pairing();
  for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) tryPair(p, '999999', 'attacker', NOW);
  // Even the CORRECT code must not work once the budget is spent.
  const r = tryPair(p, '123456', 'attacker', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'burned');
});

test('a code expires', () => {
  const p = pairing();
  assert.equal(pairingExpired(p, NOW + PAIRING_TTL_MS - 1), false);
  assert.equal(pairingExpired(p, NOW + PAIRING_TTL_MS + 1), true);
  const r = tryPair(p, '123456', 'sender', NOW + PAIRING_TTL_MS + 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'expired');
});

test('pairing with no code in progress is refused', () => {
  const r = tryPair(null, '123456', 'sender', NOW);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-pairing');
});

// ── Command parsing ───────────────────────────────────────────────────

test('commands parse, with Telegram @botname stripped', () => {
  assert.deepEqual(parseCommand('/status'), { name: 'status', args: [] });
  assert.deepEqual(parseCommand('/status@KryptBot'), { name: 'status', args: [] });
  assert.deepEqual(parseCommand('  /pair   123456  '), { name: 'pair', args: ['123456'] });
  assert.deepEqual(parseCommand('/PnL'), { name: 'pnl', args: [] }, 'case-insensitive');
});

test('non-commands parse to nothing', () => {
  assert.equal(parseCommand('hello'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand(undefined), null);
});

// ── Authorisation, the part that matters ──────────────────────────────

test('UNPAIRED: only /pair does anything', () => {
  const base = { senderId: 'someone', ownerId: null, hasPairing: true };
  assert.equal(decide({ ...base, text: '/status' }).kind, 'ignore');
  assert.equal(decide({ ...base, text: '/positions' }).kind, 'ignore');
  assert.equal(decide({ ...base, text: 'hello' }).kind, 'ignore');
  const p = decide({ ...base, text: '/pair 123456' });
  assert.equal(p.kind, 'pair');
  assert.equal(p.code, '123456');
});

test('UNPAIRED: /pair with no code is ignored, not treated as pairing', () => {
  assert.equal(decide({ text: '/pair', senderId: 's', ownerId: null, hasPairing: true }).kind, 'ignore');
});

test('PAIRED: a stranger is ignored, whatever they send', () => {
  const base = { senderId: 'stranger', ownerId: 'owner-1', hasPairing: false };
  for (const text of ['/status', '/positions', '/pnl', '/pair 123456', '/help', 'hi']) {
    const d = decide({ ...base, text });
    assert.equal(d.kind, 'ignore', `"${text}" must be ignored`);
  }
});

test('PAIRED: the owner is served', () => {
  const d = decide({ text: '/positions', senderId: 'owner-1', ownerId: 'owner-1', hasPairing: false });
  assert.equal(d.kind, 'run');
  assert.equal(d.command.name, 'positions');
});

test('PAIRED: an unknown command from the owner is ignored, not guessed at', () => {
  const d = decide({ text: '/yolo everything', senderId: 'owner-1', ownerId: 'owner-1', hasPairing: false });
  assert.equal(d.kind, 'ignore');
});

test('a paired bot cannot be re-paired by a stranger holding the code', () => {
  // Once an owner exists, pairing is over. Otherwise a leaked code would be a
  // permanent takeover route.
  const d = decide({ text: '/pair 123456', senderId: 'attacker', ownerId: 'owner-1', hasPairing: true });
  assert.equal(d.kind, 'ignore');
});

// ── The read-only guarantee ───────────────────────────────────────────

// Buying and selling from chat became possible on 2026-09-05, bounded by
// shared/botTrading.ts (off by default, buys behind a second switch, caps, a
// single-use confirmation). What must NEVER become possible is anything that
// sends SOL somewhere else, or that changes the safety settings themselves.
test('NO command can withdraw, transfer, arm or touch a key', () => {
  const banned = /^(withdraw|send|sweep|transfer|approve|sign|arm|disarm|export|key|seed|settings|wallet-set)$/;
  for (const c of COMMANDS) {
    assert.ok(!banned.test(c.name), `/${c.name} must not be a command`);
  }
  assert.equal(isKnownCommand('withdraw'), false);
  assert.equal(isKnownCommand('arm'), false);
  assert.equal(isKnownCommand('status'), true);
});

test('NO command takes an address, so SOL can never be aimed somewhere', () => {
  // A mint is a token to trade, not a destination. If any usage string ever
  // takes an address or a wallet, a chat message could aim money at it.
  for (const c of COMMANDS) {
    assert.doesNotMatch(c.usage, /<address>|<wallet>|<to>|<destination>/i, `/${c.name} must not take an address`);
  }
});

test('the trading commands exist and the help says what is off by default', () => {
  assert.equal(isKnownCommand('buy'), true);
  assert.equal(isKnownCommand('sell'), true);
  assert.equal(isKnownCommand('yes'), true, 'confirmation is part of the surface');
  assert.equal(isKnownCommand('lock'), true, 'and so is turning it off from the phone');
  assert.match(HELP_TEXT, /OFF unless you switched it on/i);
  assert.match(HELP_TEXT, /can move SOL to another address/i, 'and that it cannot move SOL anywhere else');
});

// ── Secrets ───────────────────────────────────────────────────────────

test('tokens are redacted, never shown whole', () => {
  const token = '7712345678:AAH9xYzKlmNoPqRsTuVwXyZ1234567890abc';
  const shown = redactToken(token);
  assert.ok(!shown.includes('AAH9xYzKlmNoPqRsTuVwXyZ'), 'the secret half must not survive');
  assert.ok(shown.startsWith('7712'));
  assert.equal(redactToken(''), '');
  assert.equal(redactToken('short'), '••••', 'a short string reveals nothing at all');
});

test('token shape checks catch an obviously wrong paste', () => {
  assert.equal(looksLikeToken('telegram', '7712345678:AAH9xYzKlmNoPqRsTuVwXyZ1234567890abc'), true);
  assert.equal(looksLikeToken('telegram', '@MyCoolBot'), false, 'a username is not a token');
  assert.equal(looksLikeToken('telegram', ''), false);
  assert.equal(looksLikeToken('discord', 'x'.repeat(60)), true);
  assert.equal(looksLikeToken('discord', 'too short'), false);
});

async function run() {
  for (const c of cases) {
    try {
      await c.fn();
      console.log(`ok  ${c.name}`);
      passed++;
    } catch (err) {
      console.log(`FAIL ${c.name}\n     ${err.message}`);
      process.exitCode = 1;
    }
  }
  console.log(`bots: ${passed}/${cases.length} tests passed`);
}

await run();
