// The wire between the main process and a script's sandbox.
//
// A code script runs in a hidden, sandboxed renderer: no Node, no network,
// no other window, nothing but this channel. Everything a script wants
// done comes through here as a `call`, and main decides — against the
// script's own budget — whether to do it. The sandbox is untrusted; every
// message from it is validated with `parseFromSandbox` before anything
// reads it, and a script only ever acts as the id its window was created
// for, never as one it names.
//
// Pure: no Electron here, so the harness page and the parser are testable.

export type MainToSandbox =
  | { t: 'init'; scriptId: string; code: string; chain?: string; nativeSymbol?: string; inputs?: Record<string, unknown> }
  | { t: 'event'; id: number; name: string; payload: unknown }
  | { t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string };

export type SandboxToMain =
  /** The bridge exists and the harness is running. Sent BEFORE the user's
   *  code is compiled, so main can tell "the preload never loaded" (a broken
   *  install) apart from "the script's own top-level code is still running"
   *  (slow, but healthy). Both used to surface as one opaque timeout. */
  | { t: 'alive' }
  | { t: 'ready' }
  | { t: 'done'; id: number; ok: boolean; error?: string }
  | { t: 'call'; id: number; method: string; args: unknown[] }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; line: string }
  /** Numbers a script shows on its widget (bot.stat / bot.stats / bot.clearStats).
   *  Fire-and-forget like a log line: nothing waits on it. */
  | { t: 'stats'; values: Record<string, ScriptStatValue>; clear?: boolean }
  | { t: 'error'; line: string };

/** What a script may show as one stat: a number, a short text, yes/no, or
 *  null for "unknown" (shown as an em dash, never 0). */
export type ScriptStatValue = number | string | boolean | null;
/** How many stats one script may show, how long a name and a text value may
 *  be. A widget, not a database. */
export const MAX_STAT_KEYS = 24;
export const MAX_STAT_NAME = 32;
export const MAX_STAT_TEXT = 80;

/** Methods a script may call. Anything else is refused at the wall. Keep in
 *  step with SCRIPT_API in shared/automation.ts and the harness below. */
export const SCRIPT_METHODS = [
  'buy',
  'sell',
  'sellAll',
  'order',
  'cancelOrders',
  'clearCompletedOrders',
  'templates',
  'applyTemplate',
  'alert',
  'watch',
  'unwatch',
  'subscribe',
  'unsubscribe',
  'notify',
  'callout',
  'pumpAccounts',
  'wallets',
  'calloutReply',
  'discord',
  'follow',
  'unfollow',
  'like',
  'unlike',
  'price',
  'token',
  'market',
  'links',
  'security',
  'creator',
  'analyze',
  'positions',
  'orders',
  'runners',
  'leaders',
  'wallet',
  'getState',
  'setState',
  'disable',
  'every',
  'at',
] as const;
export type ScriptMethod = (typeof SCRIPT_METHODS)[number];

/** Events main may push. */
export const SCRIPT_EVENTS = ['launch', 'launchUpdate', 'runner', 'position', 'tick', 'leaderTrade', 'order', 'alert', 'fill', 'schedule', 'interval'] as const;
export type ScriptEvent = (typeof SCRIPT_EVENTS)[number];

/** A handler that has not finished by then is a runaway. */
export const EVENT_TIMEOUT_MS = 3_000;
/**
 * The ceiling a handler cannot be extended past (2026-09-21).
 *
 * EVENT_TIMEOUT_MS is when the sandbox is first ASKED whether it is wedged or
 * merely awaiting something — a responsive handler is given another slice
 * rather than crashed, because `bot.market()` alone can take a second. This
 * is where that stops: a handler still going after thirty seconds is a bug
 * whichever side it is on, and a watchdog that never bites is not one.
 */
export const EVENT_HARD_MS = 30_000;
/** Time for the harness to say `alive`. It is sent by the first statement
 *  that runs in the page, so this only has to cover process start; missing it
 *  means the preload never installed the bridge. */
export const ALIVE_TIMEOUT_MS = 4_000;
/** Time for the script's top-level code to finish and the harness to say
 *  `ready`. Top-level `await` is allowed, so this budget belongs to the
 *  USER's code, not to the sandbox coming up. */
export const READY_TIMEOUT_MS = 8_000;
/** How long a script's top-level code may run in total, as long as the
 *  renderer keeps proving it is alive. A single `await bot.market(...)` can
 *  outlast READY_TIMEOUT_MS while a provider is parked on a 429, and killing
 *  a healthy script for that is worse than waiting. A renderer that stops
 *  answering is killed at the first check, whatever the clock says. */
export const READY_MAX_MS = 30_000;
/** Longest line a script may log; the rest is cut. */
export const MAX_LOG_LINE = 400;
/** `bot.every` floor, seconds. */
export const MIN_INTERVAL_S = 5;

const MAX_ARGS = 8;
const MAX_ARG_BYTES = 32 * 1024;

/**
 * Parse an untrusted message from the sandbox. Returns null for anything
 * malformed — a script cannot make main throw by sending garbage.
 */
export function parseFromSandbox(raw: unknown): SandboxToMain | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  switch (m.t) {
    case 'alive':
      return { t: 'alive' };
    case 'ready':
      return { t: 'ready' };
    case 'done':
      if (!isId(m.id) || typeof m.ok !== 'boolean') return null;
      return { t: 'done', id: m.id, ok: m.ok, error: typeof m.error === 'string' ? m.error.slice(0, MAX_LOG_LINE) : undefined };
    case 'call': {
      if (!isId(m.id) || typeof m.method !== 'string') return null;
      if (!(SCRIPT_METHODS as readonly string[]).includes(m.method)) return null;
      const args = Array.isArray(m.args) ? m.args : [];
      if (args.length > MAX_ARGS) return null;
      try {
        if (JSON.stringify(args).length > MAX_ARG_BYTES) return null;
      } catch {
        return null;
      }
      return { t: 'call', id: m.id, method: m.method, args };
    }
    case 'log': {
      const level = m.level === 'warn' || m.level === 'error' ? m.level : 'info';
      if (typeof m.line !== 'string') return null;
      return { t: 'log', level, line: m.line.slice(0, MAX_LOG_LINE) };
    }
    case 'stats': {
      // Untrusted like everything here: names cut, texts cut, anything that is
      // not a finite number / string / boolean / null dropped, at most
      // MAX_STAT_KEYS per message. A bad entry is skipped, not the message.
      const src = m.values;
      if (typeof src !== 'object' || src === null || Array.isArray(src)) return null;
      const values: Record<string, ScriptStatValue> = {};
      let n = 0;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (n >= MAX_STAT_KEYS) break;
        const name = k.trim().slice(0, MAX_STAT_NAME);
        if (!name) continue;
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) continue;
          values[name] = v;
        } else if (typeof v === 'string') values[name] = v.slice(0, MAX_STAT_TEXT);
        else if (typeof v === 'boolean' || v === null) values[name] = v;
        else continue;
        n++;
      }
      return { t: 'stats', values, clear: m.clear === true ? true : undefined };
    }
    case 'error':
      if (typeof m.line !== 'string') return null;
      return { t: 'error', line: m.line.slice(0, MAX_LOG_LINE) };
    default:
      return null;
  }
}

function isId(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 2 ** 31;
}

/**
 * The page a script runs in. Inline, because the sandbox may load nothing
 * from anywhere: CSP allows only this inline script and eval (the user's
 * code is compiled with `new Function`), and the session cancels every
 * network request besides.
 *
 * `webrtc 'block'` is not decoration. A data-channel-only RTCPeerConnection
 * needs no permission (so the session's permission handlers never see it),
 * is not a request (so `webRequest.onBeforeRequest` never sees it), and is
 * covered by no `*-src` directive — with `stun:<attacker-host>` it is a DNS
 * + UDP way out of a page that is promised no network at all. This directive
 * is the only thing that closes it; `rtcBlocked` in the live test proves it.
 *
 * The `bot` object lives in the same realm as the user's code; the bridge
 * it uses is reachable too. That is fine: the bridge is transport, and main
 * validates every message against the window's own script id and budget.
 */
export function sandboxPageHtml(): string {
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; webrtc 'block'">
<title>script</title>
<script>
(() => {
  const bridge = window.__krypt_sandbox;
  if (!bridge) return;
  // FIRST, before anything that can throw or block: tell main the bridge is
  // here. Without this a preload that failed to load and a script with a slow
  // top-level await are the same silence, and both were reported as
  // "no ready within 8000 ms".
  try { bridge.send({ t: 'alive' }); } catch (_) {}
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const handlers = new Map();
  const pending = new Map();
  let nextId = 1;
  let scriptId = null;
  // Static per script, so they are handed over with the code rather than
  // costing a round trip. Exposed as getters because \`bot\` is frozen before
  // init arrives. Deliberately NOT including the mode: a script that behaves
  // differently on paper is not a rehearsal of the live one.
  let chain = 'solana';
  let nativeSymbol = 'SOL';
  // Answers to whatever the script declared in its @inputs block. Static per
  // run, like the chain: they ride along with the code so reading one costs
  // no round trip, and a script cannot change what it was given.
  let input = {};

  const send = (m) => { try { bridge.send(m); } catch (_) {} };
  const str = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v); } catch (_) { return String(v); } };
  const call = (method, args) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    send({ t: 'call', id, method, args });
  });

  const atHandlers = new Map();
  const bot = Object.freeze({
    on(name, fn) {
      if (typeof name !== 'string' || typeof fn !== 'function') throw new Error('bot.on(name, fn)');
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    every(seconds, fn) {
      if (typeof fn !== 'function') throw new Error('bot.every(seconds, fn)');
      if (!handlers.has('interval')) handlers.set('interval', []);
      handlers.get('interval').push(fn);
      return call('every', [Number(seconds)]);
    },
    at(hhmm, fn) {
      if (typeof hhmm !== 'string' || typeof fn !== 'function') throw new Error("bot.at('HH:MM', fn)");
      if (!atHandlers.has(hhmm)) atHandlers.set(hhmm, []);
      atHandlers.get(hhmm).push(fn);
      return call('at', [hhmm]);
    },
    /**
     * Buy with this chain's trading wallet, or with another of your own —
     * pass its ADDRESS as the third argument (see bot.wallets).
     */
    buy: (mint, sol, wallet) => call('buy', wallet === undefined ? [mint, sol] : [mint, sol, str(wallet)]),
    sell: (mint, pct, wallet) => call('sell', wallet === undefined ? [mint, pct] : [mint, pct, str(wallet)]),
    /** Your own wallets: [{address, label, active}]. No keys, ever. */
    wallets: () => call('wallets', []),
    sellAll: () => call('sellAll', []),
    order: (req) => call('order', [req]),
    cancelOrders: (mint) => call('cancelOrders', [mint]),
    clearCompletedOrders: () => call('clearCompletedOrders', []),
    templates: () => call('templates', []),
    applyTemplate: (mint, templateId) => call('applyTemplate', [mint, templateId]),
    alert: (req) => call('alert', [req]),
    watch: (mint) => call('watch', [mint]),
    unwatch: (mint) => call('unwatch', [mint]),
    subscribe: (mint) => call('subscribe', [mint]),
    unsubscribe: (mint) => call('unsubscribe', [mint]),
    notify: (message) => call('notify', [str(message)]),
    /**
     * Post a pump.fun callout. Solana only.
     *
     * The third argument is the ADDRESS of one of your own accounts (see
     * bot.pumpAccounts); left out, the active trading wallet posts. A script
     * can only ever name an account this app holds a session for — there is
     * nothing to say here that would post as somebody else.
     */
    callout: (mint, text, wallet) => call('callout', [mint, text === undefined ? '' : str(text), wallet === undefined ? '' : str(wallet)]),
    /** Your signed-in pump.fun accounts: [{address, username, active}]. */
    pumpAccounts: () => call('pumpAccounts', []),
    /**
     * Reply to a callout this account already made on a coin. Solana only.
     *
     * A callout is one per coin per account, so this is how one is followed
     * up as the coin moves. Same third argument as callout.
     */
    calloutReply: (mint, text, wallet) => call('calloutReply', [mint, str(text ?? ''), wallet === undefined ? '' : str(wallet)]),
    /**
     * Post an embed to Discord. The first argument is the NAME of one of this
     * script's own "webhook" settings (see @inputs), never a URL — the app
     * looks the URL up, so a post only goes where you pasted one.
     * embed: {title, description, url, color, fields:[{name, value, inline}], thumbnail, footer}.
     */
    discord: (field, embed) => call('discord', [str(field ?? ''), embed ?? {}]),
    /**
     * Follow / unfollow a pump.fun user (a wallet address, a pump user id or a
     * pump.fun/profile link) as one of your accounts. Solana only. Same third
     * argument as callout: left out, the trading wallet's account acts.
     */
    follow: (user, wallet) => call('follow', [str(user ?? ''), wallet === undefined ? '' : str(wallet)]),
    unfollow: (user, wallet) => call('unfollow', [str(user ?? ''), wallet === undefined ? '' : str(wallet)]),
    /** Like / unlike a callout by its id, as one of your accounts. */
    like: (calloutId, wallet) => call('like', [str(calloutId ?? ''), wallet === undefined ? '' : str(wallet)]),
    unlike: (calloutId, wallet) => call('unlike', [str(calloutId ?? ''), wallet === undefined ? '' : str(wallet)]),
    log: (...parts) => send({ t: 'log', level: 'info', line: parts.map(str).join(' ') }),
    warn: (...parts) => send({ t: 'log', level: 'warn', line: parts.map(str).join(' ') }),
    error: (...parts) => send({ t: 'log', level: 'error', line: parts.map(str).join(' ') }),
    /**
     * Show a number (or short text) on this script's widget, live — e.g.
     * bot.stat('Callouts', 12). Same name again replaces it. Nothing waits on
     * it and it costs no action. bot.stats({...}) sets several at once;
     * bot.clearStats() empties the widget. null shows as unknown.
     */
    stat: (name, value) => send({ t: 'stats', values: { [str(name)]: value === undefined ? null : value } }),
    stats: (obj) => send({ t: 'stats', values: obj && typeof obj === 'object' ? obj : {} }),
    clearStats: () => send({ t: 'stats', values: {}, clear: true }),
    price: (mint) => call('price', [mint]),
    token: (mint) => call('token', [mint]),
    market: (mint) => call('market', [mint]),
    positions: () => call('positions', []),
    orders: (mint) => call('orders', mint === undefined ? [] : [mint]),
    runners: () => call('runners', []),
    leaders: () => call('leaders', []),
    wallet: () => call('wallet', []),
    getState: () => call('getState', []),
    setState: (obj) => call('setState', [obj]),
    disable: (reason) => call('disable', [str(reason || 'disabled by the script')]),
    now: () => Date.now(),
    /** 'solana' | 'robinhood' | 'bnb' — the chain this script runs on. */
    get chain() { return chain; },
    /** The coin every amount in this script is denominated in: SOL, ETH or BNB. */
    get nativeSymbol() { return nativeSymbol; },
    /**
     * The settings this script asked for, as the form answered them.
     *
     * Empty when the script declares no @inputs block. Every value is already
     * in its declared shape, so a range is always two numbers low-to-high and
     * a lines field is always an array of non-empty strings.
     */
    get input() { return input; },
  });

  const safeConsole = Object.freeze({
    log: bot.log, info: bot.log, warn: bot.warn,
    error: (...parts) => send({ t: 'log', level: 'error', line: parts.map(str).join(' ') }),
  });

  window.addEventListener('error', (e) => send({ t: 'error', line: String(e.message || e.error || 'error') }));
  window.addEventListener('unhandledrejection', (e) => send({ t: 'error', line: 'unhandled: ' + str(e.reason && e.reason.message || e.reason) }));

  bridge.on(async (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'init') {
      scriptId = m.scriptId;
      if (typeof m.chain === 'string' && m.chain) chain = m.chain;
      if (typeof m.nativeSymbol === 'string' && m.nativeSymbol) nativeSymbol = m.nativeSymbol;
      if (m.inputs && typeof m.inputs === 'object') input = Object.freeze(m.inputs);
      try {
        // AsyncFunction, not Function: the guide (and the generated AI
        // prompt) promise top-level \`await\`, and a plain Function body
        // throws "await is only valid in async functions" at load — an
        // error the user cannot act on. The call site already awaits.
        // Same 'unsafe-eval' permission as Function; nothing else changes.
        const fn = new AsyncFunction('bot', 'console', m.code);
        await fn(bot, safeConsole);
        send({ t: 'ready' });
      } catch (err) {
        send({ t: 'error', line: 'script failed to load: ' + (err && err.message || err) });
      }
      return;
    }
    if (m.t === 'reply') {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value); else p.reject(new Error(m.error || 'refused'));
      return;
    }
    if (m.t === 'event') {
      const list = [...(handlers.get(m.name) || [])];
      if (m.name === 'schedule' && m.payload && atHandlers.has(m.payload.at)) list.push(...atHandlers.get(m.payload.at));
      try {
        for (const fn of list) await fn(m.payload);
        send({ t: 'done', id: m.id, ok: true });
      } catch (err) {
        send({ t: 'done', id: m.id, ok: false, error: String(err && err.message || err) });
      }
    }
  });
})();
</script>`;
}
