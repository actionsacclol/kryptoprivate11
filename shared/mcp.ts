// The MCP surface — what an AI agent may ask this app to do, as pure data.
//
// WHY THIS EXISTS, AND THE ONE RULE THAT MAKES IT SAFE.
//
// The user's question was "can people connect an AI to our bot without being
// able to reverse it or remove the fees". The answer is yes, and it rests on
// a single structural decision that every tool below obeys:
//
//   **THE TOOLS TAKE INTENTS, NEVER TRANSACTIONS.**
//
// An agent may say "buy 0.1 SOL of this mint". It may not hand us a signed
// transaction, an instruction list, a fee number, a treasury address, an RPC
// URL or a settings patch. Everything a tool asks for is built by the app,
// through `engine.testTrade` / `engine.manualSell` — the same pipeline the
// buttons use — which is where `liveSigner.ts` injects the Krypt fee, checks
// the treasury pin, applies the $KRYPTO holder waiver and runs the signer's
// outflow policy. There is no code path from this file to a signature that
// skips any of it, because there is no code path from this file to a
// signature at all: it asks the engine, and the engine signs the only way it
// knows how.
//
// That is also the answer to "reverse it": the tool schemas below ARE the
// whole API surface. They expose no builder internals, no account layouts, no
// key material, no provider URLs and no settings. An agent learns what a user
// with the UI open already knows.
//
// WHAT IS DELIBERATELY NOT HERE. No wallet generation, import or export. No
// withdrawals or transfers. No bridging. No token launching. No Wallet Lab
// fan-out. No settings writes of any kind — including, especially, anything
// touching fees, the treasury, referrals or RPC endpoints. No arming of a
// copy config (reading them is fine; arming one starts unattended spending
// and stays a decision a person makes in front of the app). No raw RPC.
//
// Pure module, no imports: the catalogue, the access tiers and the budget
// gate are decided here and pinned by test/mcp.test.mjs, so the server and
// the UI cannot disagree about what a tool is allowed to do.

// ── Protocol ──────────────────────────────────────────────────────────

/**
 * MCP HAS TWO ERAS, and a server that wants to be reachable speaks both.
 *
 * Up to and including 2025-11-25 ("legacy"), a client opens with
 * `initialize`, the two sides negotiate a version, and the server may hand
 * back a session id the client echoes afterwards.
 *
 * From 2026-07-28 ("modern") all of that is gone: there is no handshake and
 * no session. Every request states its own version in `_meta`, repeats its
 * method and target in headers so a proxy can route without parsing a body,
 * and asks `server/discover` instead of `initialize`.
 *
 * The spec blesses serving both on one endpoint, and this server does —
 * today's clients send the legacy handshake, and the current spec is modern.
 * The era of a request is decided by whether its body carries the `_meta`
 * version key, never by a setting.
 */
export const MCP_PROTOCOL_VERSION = '2026-07-28';
export const MCP_SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
/** The first modern version. At or above it, the handshake does not exist. */
export const MCP_MODERN_FROM = '2026-07-28';
/** Versions are dated strings, so a string compare IS a date compare. */
export const isModernVersion = (v: string): boolean => v >= MCP_MODERN_FROM;

/** The `_meta` keys a modern request carries. Spelled once, used by both sides. */
export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** Standard JSON-RPC 2.0 codes. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;
/** MCP's own, from the modern spec. The −32020…−32099 range is reserved for
 *  the spec, so nothing here may invent one. */
export const MCP_HEADER_MISMATCH = -32020;
export const MCP_MISSING_CAPABILITY = -32021;
export const MCP_UNSUPPORTED_VERSION = -32022;

export const MCP_SERVER_NAME = 'krypto-terminal';

/**
 * What the agent is told about this app before it calls anything.
 *
 * It states the two things an agent that has not read this file would
 * otherwise get wrong: that paper and live are different worlds, and that
 * nothing here predicts. The honesty rules the rest of the app follows do not
 * stop applying because the reader is a model.
 */
export const MCP_INSTRUCTIONS = [
  'This is Krypto Terminal, a desktop memecoin trading app, running on the user’s own machine with their own wallet.',
  '',
  'Read tools report what the app has recorded. Trade tools place orders through the app’s own pipeline — the same one its buttons use, with the same fees, limits and safety breakers. You cannot sign, build or modify a transaction here, and you cannot change any setting.',
  '',
  'Every trade tool runs in the mode the user set for this connection. In paper mode nothing is bought: fills are simulated and booked to a paper record. In live mode real funds move. get_wallet tells you which mode you are in — check it before you trade, and say which one you are in when you report back.',
  '',
  'Numbers may be missing. A null is "the app does not know", never zero, and you should say so rather than filling it in. Nothing this app reports predicts what a token or a wallet will do next; past profit is not a forecast, and its own research found that copying other wallets loses money on average.',
].join('\n');

// ── Access ────────────────────────────────────────────────────────────

/**
 * How much of the app this connection may reach.
 *
 * Deliberately a ladder rather than a set of switches, and deliberately the
 * same ladder the scripting system uses: a mode that is not `live` cannot
 * spend, whatever tool is called. Paper is the default landing place for the
 * same reason it is everywhere else in this app — an automated strategy with
 * unmeasured edge should cost nothing until it has a record.
 */
export type McpAccess = 'off' | 'read' | 'paper' | 'live';
export const MCP_ACCESS_LEVELS: McpAccess[] = ['off', 'read', 'paper', 'live'];

export const MCP_ACCESS_TEXT: Record<McpAccess, { label: string; why: string }> = {
  off: { label: 'Off', why: 'No connection is accepted. The port is closed.' },
  read: { label: 'Read only', why: 'The agent can look at tokens, wallets, positions and your records. It cannot trade or change anything.' },
  paper: { label: 'Paper trading', why: 'The agent can also place trades, but they are simulated and booked to the paper record. Nothing is bought and no fee is paid.' },
  live: { label: 'Live trading', why: 'The agent can spend real funds, within the limits you set below. Every trade goes through the same pipeline, fees and breakers as the buttons.' },
};

/** Trade tools exist from `paper` up; nothing spends below `live`. */
export const canTrade = (a: McpAccess): boolean => a === 'paper' || a === 'live';
export const canSpend = (a: McpAccess): boolean => a === 'live';

// ── Tools ─────────────────────────────────────────────────────────────

/** A tool's JSON Schema, as MCP requires: an object schema, always. */
export interface McpSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface McpToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: McpSchema;
  /** `read` is available at every level above off; `trade` needs paper or live. */
  tier: 'read' | 'trade';
  /** MCP annotations — hints to the client, never a substitute for the gate. */
  readOnly: boolean;
  destructive: boolean;
}

const str = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'string', description, ...extra });
const num = (description: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ type: 'number', description, ...extra });

const MINT = str('The token’s address — base58 on Solana, 0x… on the EVM chains.');
/** Solana-only tools say so rather than taking a chain they cannot honour. */
const SOL_MINT = str('The token’s mint address — Solana, base58.');
const CHAIN = str('Which chain. Defaults to Solana.', { enum: ['solana', 'robinhood', 'bnb'] });

/**
 * Every tool, in the order a client sees them. Read tools first: an agent
 * that lists this catalogue should meet the ways of looking before the ways
 * of spending.
 */
export const MCP_TOOLS: McpToolSpec[] = [
  {
    name: 'get_wallet',
    title: 'Wallet and mode',
    description:
      'The active wallet, its balance, which chain the app is on, and — the thing to check before any trade — whether this connection is in paper or live mode, plus why live is blocked if it is.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_positions',
    title: 'Open positions',
    description:
      'What the wallet currently holds: token, amount, what it cost, what it is worth now and the unrealised result. In paper mode this is the paper book. A value the app cannot price comes back null, not zero.',
    inputSchema: { type: 'object', properties: { chain: CHAIN }, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_token',
    title: 'Look up a token',
    description:
      'Everything the app knows about one token: name, price, market cap, liquidity, holders, age, launchpad, its links, and the security report with each check’s verdict. Unknown fields are null.',
    inputSchema: { type: 'object', properties: { mint: MINT, chain: CHAIN }, required: ['mint'], additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'find_tokens',
    title: 'Browse new tokens',
    description:
      'The lists the Discover page shows: brand new launches, ones approaching graduation, and ones that have migrated to a pool. This is what the app is watching, not a recommendation.',
    inputSchema: {
      type: 'object',
      properties: {
        list: str('Which list to read.', { enum: ['new', 'graduating', 'migrated'] }),
        limit: num('How many rows. 1–50, default 20.', { minimum: 1, maximum: 50 }),
        chain: CHAIN,
      },
      required: ['list'],
      additionalProperties: false,
    },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_wallet_scores',
    title: 'Wallet Scout board',
    description:
      'Wallets the app has on record, ranked by Copy score — what a FOLLOWER would have realised mirroring them, not what the wallet itself made. The app’s own research found no group of wallets profitable to copy, so this ranks least-bad to follow and is not an edge.',
    inputSchema: {
      type: 'object',
      properties: {
        chain: CHAIN,
        window: str('Period to score over. Default week.', { enum: ['day', 'week', 'month', 'all'] }),
        limit: num('How many wallets. 1–50, default 20.', { minimum: 1, maximum: 50 }),
        onlyWorthALook: { type: 'boolean', description: 'Apply the board’s five filters: no bots, enough finished trades, trips a copier could have been inside, holds over a minute, active on several days.' },
      },
      additionalProperties: false,
    },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_wallet_record',
    title: 'One wallet’s record',
    description:
      'A single wallet’s record: its trips, profit, win rate, median hold, the checks behind its Copy score, and what a copier would have realised on its recent trips. Empty when the app has never seen the address.',
    inputSchema: { type: 'object', properties: { address: str('The wallet address.'), chain: CHAIN }, required: ['address'], additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_copy_configs',
    title: 'Copy trading setup',
    description:
      'The copy-trading configs and how each is doing: who is followed, direction, paper or live, whether it is armed, and its record. Read only — arming a config starts unattended spending and stays something the user does in the app.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_orders',
    title: 'Open orders',
    description: 'Advanced orders waiting to fire — stop losses, take profits, trailing stops and limits — with what each is watching for.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_trade_history',
    title: 'Recent trades',
    description:
      'Fills this install has made, newest first, with the cost basis taken from the on-chain amounts rather than what was requested — so the profit figures include fees, tips and slippage.',
    inputSchema: { type: 'object', properties: { limit: num('How many. 1–100, default 25.', { minimum: 1, maximum: 100 }) }, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_chart',
    title: 'Price history',
    description:
      'Candles for a token — open, high, low, close and volume per bar. Built from the app’s own tape merged with its providers, so recent bars are what this install saw. Solana only.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: SOL_MINT,
        interval: str('Bar size. Default 1m.', { enum: ['1s', '15s', '1m', '5m', '15m', '1h'] }),
        limit: num('How many bars, newest last. 10–500, default 120.', { minimum: 10, maximum: 500 }),
      },
      required: ['mint'],
      additionalProperties: false,
    },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_token_links',
    title: 'A token’s links',
    description:
      'Where a token points: its X account or post, website and launchpad page, plus what the app has already read about them — X follower counts if a person opened the panel, Telegram member counts, the website’s domain age, and how many OTHER launches share the same X account or post. Nothing is fetched by this call and the app never visits a link on its own, so fields are null until someone has looked. Solana only.',
    inputSchema: { type: 'object', properties: { mint: SOL_MINT }, required: ['mint'], additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_runner_alerts',
    title: 'Flagged potential runners',
    description:
      'Launches the scanner flagged this session because their early buying matched a bucket that graduated more often on a measured day. Each row carries the observed rate, the base rate and the sample it came from. A flag is a reason to look, not a prediction — most flagged launches still do not graduate, and the app buys nothing on one.',
    inputSchema: { type: 'object', properties: { chain: CHAIN, limit: num('How many, newest first. 1–50, default 20.', { minimum: 1, maximum: 50 }) }, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'get_callouts',
    title: 'pump.fun callouts',
    description:
      'The public callouts feed from pump.fun: who called which coin, when, and what position the caller holds in it. This is pump’s own feed reported as it stands. It is not a recommendation and the numbers in it are the caller’s claims about themselves.',
    inputSchema: { type: 'object', properties: { limit: num('How many, newest first. 1–50, default 20.', { minimum: 1, maximum: 50 }) }, additionalProperties: false },
    tier: 'read',
    readOnly: true,
    destructive: false,
  },
  {
    name: 'buy_token',
    title: 'Buy a token',
    description:
      'Spend the chain’s own coin on a token, through the app’s own pipeline. In paper mode the fill is simulated and nothing is bought. Refused, with the reason, when it is over the per-trade cap, over the hourly cap, too fast, or while live trading is blocked.',
    inputSchema: {
      type: 'object',
      properties: { mint: MINT, amount: num('How much of the chain’s own coin to spend — SOL, ETH or BNB.', { exclusiveMinimum: 0 }), chain: CHAIN },
      required: ['mint', 'amount'],
      additionalProperties: false,
    },
    tier: 'trade',
    readOnly: false,
    destructive: false,
  },
  {
    name: 'sell_token',
    title: 'Sell a token',
    description: 'Sell a percentage of what the wallet holds of a token, through the app’s own pipeline. In paper mode it sells from the paper book.',
    inputSchema: {
      type: 'object',
      properties: { mint: MINT, percent: num('Share of the holding to sell, 1–100.', { minimum: 1, maximum: 100 }), chain: CHAIN },
      required: ['mint', 'percent'],
      additionalProperties: false,
    },
    tier: 'trade',
    readOnly: false,
    destructive: true,
  },
  {
    name: 'place_order',
    title: 'Place an advanced order',
    description:
      'Arm a stop loss, take profit, trailing stop or limit order on a token. It is a real order in the app and will fire without the agent. Solana only.',
    inputSchema: {
      type: 'object',
      properties: {
        mint: SOL_MINT,
        kind: str('What kind of order.', { enum: ['stop_loss', 'take_profit', 'trailing_stop', 'limit_buy', 'limit_sell'] }),
        triggerBasis: str('How the trigger is measured. Limit orders need an absolute level, so pct is refused for them.', { enum: ['pct', 'price_sol', 'mcap_usd'] }),
        triggerValue: num('The trigger: a percent move for pct, else the price in SOL or the market cap in USD.'),
        amount: num('SOL to spend for a buy, or the percent of the holding to sell.'),
      },
      required: ['mint', 'kind', 'triggerBasis', 'triggerValue', 'amount'],
      additionalProperties: false,
    },
    tier: 'trade',
    readOnly: false,
    destructive: false,
  },
  {
    name: 'cancel_orders',
    title: 'Cancel orders',
    description: 'Cancel every armed advanced order on one Solana token.',
    inputSchema: { type: 'object', properties: { mint: SOL_MINT }, required: ['mint'], additionalProperties: false },
    tier: 'trade',
    readOnly: false,
    destructive: true,
  },
];

export const toolByName = (name: string): McpToolSpec | null => MCP_TOOLS.find((t) => t.name === name) ?? null;

/** The tools a connection at this access level may see and call. */
export function toolsFor(access: McpAccess): McpToolSpec[] {
  if (access === 'off') return [];
  if (!canTrade(access)) return MCP_TOOLS.filter((t) => t.tier === 'read');
  return MCP_TOOLS;
}

/**
 * May this access level call this tool?
 *
 * The gate, and the only one that matters: `toolsFor` decides what is
 * ADVERTISED, this decides what is ANSWERED. A client that calls a tool it
 * was never shown is refused here, not merely absent from a list.
 */
export function toolAllowed(name: string, access: McpAccess): { ok: boolean; reason: string } {
  if (access === 'off') return { ok: false, reason: 'The MCP connection is switched off in the app.' };
  const t = toolByName(name);
  if (!t) return { ok: false, reason: `No such tool: ${name}` };
  if (t.tier === 'trade' && !canTrade(access)) {
    return { ok: false, reason: 'This connection is read only. Trading tools are switched off in the app under Settings → AI connection.' };
  }
  return { ok: true, reason: 'ok' };
}

// ── Settings ──────────────────────────────────────────────────────────

/**
 * The budget, mirroring `BotTradePolicy` in shared/botTrading.ts and for the
 * same reason: an automated caller that can spend needs a per-trade ceiling,
 * a rolling cap and a rate limit, all of them the user's numbers rather than
 * the caller's. Sells are deliberately not capped by value — the worst case
 * of an unwanted sell is an exit into the user's own wallet, and being able
 * to close a position is the point of letting an agent trade at all.
 */
export interface McpBudget {
  /** Largest single buy, in the chain's coin. */
  maxBuySol: number;
  /** Total buying allowed in a rolling hour. */
  hourlyCapSol: number;
  /** Trades of any kind per minute, however fast the agent calls. */
  maxTradesPerMinute: number;
}

export interface McpSettings {
  /** The listener. Off = no port is open, whatever `access` says. */
  enabled: boolean;
  /** How far this connection reaches. Owned by main (`mcp:setAccess`). */
  access: McpAccess;
  /** Loopback port. */
  port: number;
  /** Bearer token. Generated in main, never set from the renderer. */
  token: string;
  budget: McpBudget;
}

export const DEFAULT_MCP_BUDGET: McpBudget = { maxBuySol: 0.1, hourlyCapSol: 0.5, maxTradesPerMinute: 4 };

/** Off, read-only, no token. Everything about this feature is opt-in. */
export const DEFAULT_MCP_SETTINGS: McpSettings = {
  enabled: false,
  access: 'read',
  port: 8787,
  token: '',
  budget: { ...DEFAULT_MCP_BUDGET },
};

export const MCP_PORT_MIN = 1024;
export const MCP_PORT_MAX = 65535;
/** Hex characters in a token. 32 bytes of randomness. */
export const MCP_TOKEN_CHARS = 64;

// ── The budget gate ───────────────────────────────────────────────────

export interface McpTradeAttempt {
  at: number;
  kind: 'buy' | 'sell';
  /** Coin committed on a buy; 0 for a sell. */
  sol: number;
}

/**
 * May this trade go ahead?
 *
 * Pure, so the rule is the same in the test and in the server, and so the
 * refusal text is one string rather than one per call site. Checked BEFORE
 * anything is sent, and the caller RESERVES the attempt (records it) before it
 * asks the app — so two near-simultaneous buys cannot both read the same
 * pre-count and slip past the cap. It fails closed: a trade the app then
 * rejects still consumed its slot until the window rolls, which is the safe
 * direction for a spending guard.
 */
export function checkMcpTrade(
  intent: { kind: 'buy' | 'sell'; amount: number },
  access: McpAccess,
  budget: McpBudget,
  recent: readonly McpTradeAttempt[],
  now: number,
): { ok: boolean; reason: string } {
  if (!canTrade(access)) return { ok: false, reason: 'This connection is read only. Trading is switched off in the app under Settings → AI connection.' };
  const minuteAgo = now - 60_000;
  if (recent.filter((r) => r.at >= minuteAgo).length >= budget.maxTradesPerMinute) {
    return { ok: false, reason: `Over ${budget.maxTradesPerMinute} trades in a minute. Wait before trying again.` };
  }
  if (intent.kind === 'sell') {
    if (!(intent.amount >= 1 && intent.amount <= 100)) return { ok: false, reason: 'percent must be between 1 and 100' };
    return { ok: true, reason: 'ok' };
  }
  if (!(intent.amount > 0)) return { ok: false, reason: 'amount must be greater than zero' };
  // The caps bound LIVE spending. In paper nothing is committed, and a paper
  // record built under tighter limits than the live one would be measuring a
  // strategy the user never intends to run.
  if (!canSpend(access)) return { ok: true, reason: 'ok' };
  if (intent.amount > budget.maxBuySol) {
    return { ok: false, reason: `That is above the ${budget.maxBuySol} per-trade limit for this connection. Change it in the app under Settings → AI connection.` };
  }
  const hourAgo = now - 3_600_000;
  const spent = recent.filter((r) => r.at >= hourAgo && r.kind === 'buy').reduce((a, r) => a + r.sol, 0);
  if (spent + intent.amount > budget.hourlyCapSol) {
    const left = Math.max(0, budget.hourlyCapSol - spent);
    return { ok: false, reason: `That would pass the ${budget.hourlyCapSol} hourly limit for this connection (${left.toFixed(3)} left this hour).` };
  }
  return { ok: true, reason: 'ok' };
}

// ── Connecting ────────────────────────────────────────────────────────

/** The loopback URL a client connects to. */
export const mcpUrl = (port: number): string => `http://127.0.0.1:${port}/mcp`;

/**
 * The one line a user pastes into a terminal to connect Claude Code.
 *
 * Built here so the UI, the guide and the test all show the same command; the
 * token is the user's, so this string is a secret while it is on screen.
 */
export function mcpAddCommand(port: number, token: string): string {
  return `claude mcp add --transport http ${MCP_SERVER_NAME} ${mcpUrl(port)} --header "Authorization: Bearer ${token}"`;
}

/** The same thing as a config-file entry, for clients that take JSON. */
export function mcpJsonConfig(port: number, token: string): string {
  return JSON.stringify(
    { mcpServers: { [MCP_SERVER_NAME]: { type: 'http', url: mcpUrl(port), headers: { Authorization: `Bearer ${token}` } } } },
    null,
    2,
  );
}
