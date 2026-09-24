// The MCP surface (shared/mcp.ts) — what an AI agent may ask this app to do.
//
// The whole safety argument for this feature is structural, so it is the
// structure that gets pinned here:
//
//   • no tool takes a transaction, a fee, a treasury, an endpoint or a
//     setting — the agent states an intent and the app builds the trade;
//   • the access ladder gates ANSWERS, not just the advertised list;
//   • nothing spends below `live`, and what does spend is bounded.
//
// A tool added later that breaks any of those fails here rather than in
// someone's wallet.

import assert from 'node:assert';
import {
  DEFAULT_MCP_BUDGET,
  DEFAULT_MCP_SETTINGS,
  MCP_ACCESS_LEVELS,
  MCP_ACCESS_TEXT,
  MCP_INSTRUCTIONS,
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCP_TOKEN_CHARS,
  MCP_TOOLS,
  canSpend,
  canTrade,
  checkMcpTrade,
  mcpAddCommand,
  mcpJsonConfig,
  mcpUrl,
  toolAllowed,
  toolByName,
  toolsFor,
} from './.mcp.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

// ── the catalogue is well formed ─────────────────────────────────────────
{
  assert.ok(MCP_TOOLS.length >= 10, 'a catalogue worth connecting to');
  const names = MCP_TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  for (const t of MCP_TOOLS) {
    assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name}: snake_case, as every MCP client expects`);
    assert.ok(t.title.length > 0, `${t.name} has a title`);
    assert.ok(t.description.length > 40, `${t.name}'s description says what it does`);
    assert.equal(t.inputSchema.type, 'object', `${t.name}'s schema is an object schema`);
    // Refusing unknown properties is what stops an agent smuggling a field
    // the app never agreed to read.
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} refuses unknown arguments`);
    for (const r of t.inputSchema.required ?? []) {
      assert.ok(r in t.inputSchema.properties, `${t.name}: required argument ${r} is described`);
    }
    for (const [k, v] of Object.entries(t.inputSchema.properties)) {
      assert.ok(typeof v === 'object' && v !== null && typeof v.description === 'string' && v.description.length > 0, `${t.name}.${k} is described`);
    }
    assert.equal(t.readOnly, t.tier === 'read', `${t.name}: the read-only hint matches its tier`);
  }
  // Read tools come first, so an agent listing the catalogue meets the ways
  // of looking before the ways of spending.
  const firstTrade = MCP_TOOLS.findIndex((t) => t.tier === 'trade');
  assert.ok(MCP_TOOLS.slice(0, firstTrade).every((t) => t.tier === 'read'), 'the read tools are listed first');
  ok('every tool has a unique snake_case name, a described object schema that refuses unknown fields, and an honest read-only hint');
}

// ── the rule that makes this safe: intents, never transactions ───────────
{
  // A tool that accepted any of these would be a way around the signer — and
  // therefore around the fee, the treasury pin and the outflow policy.
  const FORBIDDEN = [
    'transaction', 'tx', 'signed', 'signature', 'instruction', 'instructions', 'serialized', 'base64',
    'fee', 'feeBps', 'treasury', 'referral', 'rpc', 'endpoint', 'url', 'privateKey', 'secret', 'seed',
    'keypair', 'setting', 'settings', 'slippage', 'priorityFee', 'tip',
  ];
  for (const t of MCP_TOOLS) {
    for (const k of Object.keys(t.inputSchema.properties)) {
      assert.ok(!FORBIDDEN.includes(k), `${t.name} must not take "${k}" — the app builds the trade, the agent only asks for one`);
    }
  }
  // And nothing in the catalogue offers the operations that move funds
  // somewhere other than a trade, or that change how a trade is built.
  const BANNED_TOOLS = /withdraw|transfer|send|bridge|launch|create_token|import|export|key|settings|set_fee|arm|enable_copy/i;
  for (const t of MCP_TOOLS) assert.ok(!BANNED_TOOLS.test(t.name), `${t.name} is not an operation this surface may offer`);
  ok('no tool takes a transaction, a fee, a treasury, an endpoint or a setting, and none offers a withdrawal or a launch');
}

// ── the access ladder ────────────────────────────────────────────────────
{
  assert.deepEqual(MCP_ACCESS_LEVELS, ['off', 'read', 'paper', 'live']);
  for (const a of MCP_ACCESS_LEVELS) assert.ok(MCP_ACCESS_TEXT[a].label && MCP_ACCESS_TEXT[a].why.length > 20, `${a} explains itself`);
  assert.equal(canTrade('off'), false);
  assert.equal(canTrade('read'), false);
  assert.equal(canTrade('paper'), true);
  assert.equal(canTrade('live'), true);
  assert.equal(canSpend('paper'), false, 'paper never spends');
  assert.equal(canSpend('live'), true);

  assert.equal(toolsFor('off').length, 0, 'switched off, nothing is offered');
  assert.ok(toolsFor('read').every((t) => t.tier === 'read'));
  assert.equal(toolsFor('live').length, MCP_TOOLS.length);
  assert.equal(toolsFor('paper').length, MCP_TOOLS.length, 'paper sees the trade tools — they are simulated, not absent');

  // The gate answers, it does not merely hide: a client that calls a tool it
  // was never shown is refused with a reason.
  const trade = MCP_TOOLS.find((t) => t.tier === 'trade');
  assert.equal(toolAllowed(trade.name, 'read').ok, false, 'a trade tool is refused on a read-only connection');
  assert.match(toolAllowed(trade.name, 'read').reason, /read only/i);
  assert.equal(toolAllowed(trade.name, 'paper').ok, true);
  assert.equal(toolAllowed('get_wallet', 'read').ok, true);
  assert.equal(toolAllowed('get_wallet', 'off').ok, false, 'off refuses everything, including reads');
  assert.equal(toolAllowed('definitely_not_a_tool', 'live').ok, false);
  assert.equal(toolByName('get_wallet')?.tier, 'read');
  assert.equal(toolByName('nope'), null);
  ok('the ladder gates answers, not just the advertised list: off refuses reads, read refuses trades, paper trades without spending');
}

// ── the budget ───────────────────────────────────────────────────────────
{
  const b = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4 };
  const now = 1_000_000_000;
  const none = [];

  assert.equal(checkMcpTrade({ kind: 'buy', amount: 0.05 }, 'read', b, none, now).ok, false, 'read cannot trade at all');
  assert.equal(checkMcpTrade({ kind: 'buy', amount: 0.05 }, 'live', b, none, now).ok, true);

  // Over the per-trade cap.
  const over = checkMcpTrade({ kind: 'buy', amount: 1 }, 'live', b, none, now);
  assert.equal(over.ok, false);
  assert.match(over.reason, /0\.1 per-trade limit/);

  // The hourly cap counts buys inside the hour, and only buys.
  const spent = [
    { at: now - 60_000, kind: 'buy', sol: 0.3 },
    { at: now - 120_000, kind: 'buy', sol: 0.15 },
    { at: now - 90_000, kind: 'sell', sol: 0 },
    { at: now - 3_700_000, kind: 'buy', sol: 5 },
  ];
  const cap = checkMcpTrade({ kind: 'buy', amount: 0.1 }, 'live', b, spent, now);
  assert.equal(cap.ok, false, '0.45 spent + 0.1 passes the 0.5 cap');
  assert.match(cap.reason, /0\.050 left this hour/, 'the refusal says how much is left');
  assert.equal(checkMcpTrade({ kind: 'buy', amount: 0.05 }, 'live', b, spent, now).ok, true, 'exactly at the cap is allowed');

  // Paper is bounded by the rate limit but NOT by the value caps: a paper
  // record built under tighter limits measures a strategy nobody will run.
  assert.equal(checkMcpTrade({ kind: 'buy', amount: 999 }, 'paper', b, spent, now).ok, true);

  // The rate limit counts every trade, buy or sell, at every level.
  const fast = [0, 1, 2, 3].map((i) => ({ at: now - i * 1_000, kind: 'sell', sol: 0 }));
  assert.equal(checkMcpTrade({ kind: 'sell', amount: 100 }, 'live', b, fast, now).ok, false);
  assert.match(checkMcpTrade({ kind: 'sell', amount: 100 }, 'paper', b, fast, now).reason, /4 trades in a minute/);
  assert.equal(checkMcpTrade({ kind: 'sell', amount: 100 }, 'live', b, fast.slice(1), now).ok, true, 'three in the minute still passes');

  // A sell is never refused for value — the worst case of an unwanted sell is
  // an exit into the user's own wallet — but its percent must be a percent.
  assert.equal(checkMcpTrade({ kind: 'sell', amount: 100 }, 'live', b, none, now).ok, true);
  assert.equal(checkMcpTrade({ kind: 'sell', amount: 0 }, 'live', b, none, now).ok, false);
  assert.equal(checkMcpTrade({ kind: 'sell', amount: 101 }, 'live', b, none, now).ok, false);
  assert.equal(checkMcpTrade({ kind: 'buy', amount: 0 }, 'live', b, none, now).ok, false);
  ok('buys are capped per trade and per hour in live only, sells are never value-capped, and the rate limit binds every level');
}

// ── defaults and the connect string ──────────────────────────────────────
{
  assert.equal(DEFAULT_MCP_SETTINGS.enabled, false, 'the port is closed until the user opens it');
  assert.equal(DEFAULT_MCP_SETTINGS.access, 'read', 'and read-only when they do');
  assert.equal(DEFAULT_MCP_SETTINGS.token, '', 'no token until one is generated in main');
  assert.deepEqual(DEFAULT_MCP_SETTINGS.budget, DEFAULT_MCP_BUDGET);
  assert.ok(DEFAULT_MCP_BUDGET.maxBuySol <= DEFAULT_MCP_BUDGET.hourlyCapSol, 'a default that refuses its own first trade would be a bug');

  assert.equal(mcpUrl(8787), 'http://127.0.0.1:8787/mcp', 'loopback, always — never a routable address');
  const cmd = mcpAddCommand(8787, 'deadbeef');
  assert.match(cmd, /^claude mcp add --transport http /);
  assert.ok(cmd.includes('http://127.0.0.1:8787/mcp'));
  assert.ok(cmd.includes('Authorization: Bearer deadbeef'));
  const cfg = JSON.parse(mcpJsonConfig(8787, 'deadbeef'));
  const entry = cfg.mcpServers['krypto-terminal'];
  assert.equal(entry.type, 'http');
  assert.equal(entry.url, 'http://127.0.0.1:8787/mcp');
  assert.equal(entry.headers.Authorization, 'Bearer deadbeef');

  assert.ok(MCP_SUPPORTED_VERSIONS.includes(MCP_PROTOCOL_VERSION), 'the version we speak is one we accept');
  assert.equal(MCP_TOKEN_CHARS, 64, '32 bytes of randomness');
  // The agent is told the two things it would otherwise get wrong.
  assert.match(MCP_INSTRUCTIONS, /paper/i);
  assert.match(MCP_INSTRUCTIONS, /cannot sign, build or modify a transaction/i);
  assert.match(MCP_INSTRUCTIONS, /null is "the app does not know"/i);
  ok('the feature ships off and read-only, the connect string is loopback with a bearer token, and the agent is told what paper means');
}

console.log(`\nmcp: ${passed}/5 passed`);
