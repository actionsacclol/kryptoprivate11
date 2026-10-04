"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// electron/system/scriptSandbox.ts
var scriptSandbox_exports = {};
__export(scriptSandbox_exports, {
  _failNextLoad: () => _failNextLoad,
  _setPreloadPath: () => _setPreloadPath,
  dispatch: () => dispatch,
  install: () => install,
  isRunning: () => isRunning,
  memoryMB: () => memoryMB,
  reply: () => reply,
  start: () => start,
  stop: () => stop,
  stopAll: () => stopAll
});
module.exports = __toCommonJS(scriptSandbox_exports);
var import_electron = require("electron");
var import_node_path = __toESM(require("node:path"));

// shared/scriptProtocol.ts
var MAX_STAT_KEYS = 24;
var MAX_STAT_NAME = 32;
var MAX_STAT_TEXT = 80;
var SCRIPT_METHODS = [
  "buy",
  "sell",
  "sellAll",
  "order",
  "cancelOrders",
  "clearCompletedOrders",
  "templates",
  "applyTemplate",
  "alert",
  "watch",
  "unwatch",
  "subscribe",
  "unsubscribe",
  "notify",
  "callout",
  "pumpAccounts",
  "wallets",
  "calloutReply",
  "discord",
  "discordEdit",
  "follow",
  "unfollow",
  "like",
  "unlike",
  "price",
  "token",
  "market",
  "links",
  "security",
  "creator",
  "analyze",
  // Every other read the app has (2026-09-27): the Launch tab's cohorts,
  // holders, the trade tape, candles, search and Discover, the callouts
  // feed, this install's fills, the wallet's bags, SOL/USD, Wallet Scout,
  // the copy configs and the alerts. Reads, all of them.
  "launchIntel",
  "holders",
  "trades",
  "candles",
  "search",
  "discover",
  "callouts",
  "coinCallouts",
  "history",
  "holdings",
  "solUsd",
  // The chain's own coin in USD (2026-10-03), and the All-in-One wallet.
  "nativeUsd",
  "aioInfo",
  "aioBalances",
  "aioMove",
  "walletScores",
  "walletRecord",
  "copyConfigs",
  "alerts",
  // Housekeeping the pages have and scripts did not (2026-09-27): one order
  // by id, the paused orders, one alert, the fired alerts, the templates.
  "cancelOrder",
  "resumeOrders",
  "removeAlert",
  "muteAlert",
  "clearFiredAlerts",
  "saveTemplate",
  "deleteTemplate",
  "setActiveTemplate",
  /** The app's settings, read-only and without a single key or URL. */
  "settings",
  "positions",
  "orders",
  "runners",
  "leaders",
  "wallet",
  "getState",
  "setState",
  "disable",
  "every",
  "at"
];
var EVENT_TIMEOUT_MS = 3e3;
var EVENT_HARD_MS = 3e4;
var ALIVE_TIMEOUT_MS = 4e3;
var READY_TIMEOUT_MS = 8e3;
var READY_MAX_MS = 3e4;
var PROBE_SLICE_MS = 2e3;
var PROBE_SILENT_SLICES = 3;
var PROBE_LATE_MS = 400;
var PROBE_MAX_SLICES = 10;
function probeResponsive(d) {
  const now = d.now ?? Date.now;
  const slice = d.sliceMs ?? PROBE_SLICE_MS;
  const silentMax = d.silentSlices ?? PROBE_SILENT_SLICES;
  const lateMs = d.lateMs ?? PROBE_LATE_MS;
  const maxSlices = d.maxSlices ?? PROBE_MAX_SLICES;
  if (d.gone()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    let silent = 0;
    let slices = 0;
    const done = (v) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(v);
    };
    const ask = () => {
      try {
        d.ask().then(
          () => done(true),
          () => done(false)
        );
      } catch {
        done(false);
      }
    };
    const arm = () => {
      const due = now() + slice;
      timer = setTimeout(() => {
        if (settled) return;
        slices += 1;
        if (d.gone()) return done(false);
        if (now() - due < lateMs) silent += 1;
        if (silent >= silentMax || slices >= maxSlices) return done(false);
        ask();
        arm();
      }, slice);
    };
    ask();
    arm();
  });
}
var MAX_LOG_LINE = 400;
var MAX_ARGS = 8;
var MAX_ARG_BYTES = 32 * 1024;
function parseFromSandbox(raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const m = raw;
  switch (m.t) {
    case "alive":
      return { t: "alive" };
    case "ready":
      return { t: "ready" };
    case "done":
      if (!isId(m.id) || typeof m.ok !== "boolean") return null;
      return { t: "done", id: m.id, ok: m.ok, error: typeof m.error === "string" ? m.error.slice(0, MAX_LOG_LINE) : void 0 };
    case "call": {
      if (!isId(m.id) || typeof m.method !== "string") return null;
      if (!SCRIPT_METHODS.includes(m.method)) return null;
      const args = Array.isArray(m.args) ? m.args : [];
      if (args.length > MAX_ARGS) return null;
      try {
        if (JSON.stringify(args).length > MAX_ARG_BYTES) return null;
      } catch {
        return null;
      }
      return { t: "call", id: m.id, method: m.method, args };
    }
    case "log": {
      const level = m.level === "warn" || m.level === "error" ? m.level : "info";
      if (typeof m.line !== "string") return null;
      return { t: "log", level, line: m.line.slice(0, MAX_LOG_LINE) };
    }
    case "stats": {
      const src = m.values;
      if (typeof src !== "object" || src === null || Array.isArray(src)) return null;
      const values = {};
      let n = 0;
      for (const [k, v] of Object.entries(src)) {
        if (n >= MAX_STAT_KEYS) break;
        const name = k.trim().slice(0, MAX_STAT_NAME);
        if (!name) continue;
        if (typeof v === "number") {
          if (!Number.isFinite(v)) continue;
          values[name] = v;
        } else if (typeof v === "string") values[name] = v.slice(0, MAX_STAT_TEXT);
        else if (typeof v === "boolean" || v === null) values[name] = v;
        else continue;
        n++;
      }
      return { t: "stats", values, clear: m.clear === true ? true : void 0 };
    }
    case "error":
      if (typeof m.line !== "string") return null;
      return { t: "error", line: m.line.slice(0, MAX_LOG_LINE) };
    default:
      return null;
  }
}
function isId(v) {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 2 ** 31;
}
function sandboxPageHtml() {
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
  const timerHandlers = new Map();
  let nextTimerId = 1;
  const bot = Object.freeze({
    on(name, fn) {
      if (typeof name !== 'string' || typeof fn !== 'function') throw new Error('bot.on(name, fn)');
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(fn);
    },
    // Each call is its OWN timer (2026-09-29): main fires it with its id and
    // only its handler runs. They used to share one list and one timer, so
    // the last interval set won \u2014 a bot.every(3600) silenced a bot.every(30).
    every(seconds, fn) {
      if (typeof fn !== 'function') throw new Error('bot.every(seconds, fn)');
      const id = nextTimerId++;
      timerHandlers.set(id, fn);
      return call('every', [Number(seconds), id]);
    },
    at(hhmm, fn) {
      if (typeof hhmm !== 'string' || typeof fn !== 'function') throw new Error("bot.at('HH:MM', fn)");
      if (!atHandlers.has(hhmm)) atHandlers.set(hhmm, []);
      atHandlers.get(hhmm).push(fn);
      return call('at', [hhmm]);
    },
    /**
     * Buy with this chain's trading wallet, or with another of your own \u2014
     * pass its ADDRESS as the third argument (see bot.wallets).
     */
    // The third argument is an ADDRESS (a string) or an options object
    // {wallet, slippagePct}; a sell's second may be a percent or
    // {pct | tokens, slippagePct, wallet}. Objects pass through as they are:
    // main reads and bounds every field.
    buy: (mint, sol, wallet) => call('buy', wallet === undefined ? [mint, sol] : [mint, sol, wallet !== null && typeof wallet === 'object' ? wallet : str(wallet)]),
    sell: (mint, pct, wallet) => call('sell', wallet === undefined ? [mint, pct] : [mint, pct, wallet !== null && typeof wallet === 'object' ? wallet : str(wallet)]),
    /** Your own wallets: [{address, label, active}]. No keys, ever. */
    wallets: () => call('wallets', []),
    sellAll: () => call('sellAll', []),
    order: (req) => call('order', [req]),
    cancelOrders: (mint, kinds) => call('cancelOrders', kinds === undefined ? [mint] : [mint, kinds]),
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
     * can only ever name an account this app holds a session for \u2014 there is
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
     * script's own "webhook" settings (see @inputs), never a URL \u2014 the app
     * looks the URL up, so a post only goes where you pasted one.
     * embed: {title, description, url, color, fields:[{name, value, inline}], thumbnail, footer}.
     */
    discord: (field, embed) => call('discord', [str(field ?? ''), embed ?? {}]),
    /**
     * Replace the embed on a message bot.discord posted \u2014 pass the messageId
     * it returned. For showing how a call ended on the call itself. Edit
     * only: there is deliberately no delete.
     */
    discordEdit: (field, messageId, embed) => call('discordEdit', [str(field ?? ''), str(messageId ?? ''), embed ?? {}]),
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
     * Show a number (or short text) on this script's widget, live \u2014 e.g.
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
    links: (mint) => call('links', [mint]),
    security: (mint) => call('security', [mint]),
    creator: (mint) => call('creator', [mint]),
    analyze: (mint) => call('analyze', [mint]),
    /** The Launch tab's cohorts: who bought the first blocks and what they hold now. */
    launchIntel: (mint) => call('launchIntel', [mint]),
    holders: (mint, limit) => call('holders', limit === undefined ? [mint] : [mint, Number(limit)]),
    trades: (mint, limit) => call('trades', limit === undefined ? [mint] : [mint, Number(limit)]),
    candles: (mint, interval, limit) => call('candles', [mint, interval === undefined ? '1m' : str(interval), limit === undefined ? 120 : Number(limit)]),
    search: (query) => call('search', [str(query === undefined ? '' : query)]),
    discover: (list, limit) => call('discover', [str(list === undefined ? 'new' : list), limit === undefined ? 20 : Number(limit)]),
    callouts: (limit) => call('callouts', limit === undefined ? [] : [Number(limit)]),
    coinCallouts: (mint) => call('coinCallouts', [mint]),
    history: (limit) => call('history', limit === undefined ? [] : [Number(limit)]),
    holdings: () => call('holdings', []),
    solUsd: () => call('solUsd', []),
    nativeUsd: () => call('nativeUsd', []),
    /** The All-in-One wallet: one wallet on every chain (2026-10-03). */
    aio: Object.freeze({
      info: () => call('aioInfo', []),
      balances: () => call('aioBalances', []),
      move: (from, to, amount) => call('aioMove', [str(from), str(to), Number(amount)]),
    }),
    walletScores: (opts) => call('walletScores', [opts && typeof opts === 'object' ? opts : {}]),
    walletRecord: (address) => call('walletRecord', [str(address === undefined ? '' : address)]),
    copyConfigs: () => call('copyConfigs', []),
    alerts: () => call('alerts', []),
    cancelOrder: (id) => call('cancelOrder', [str(id === undefined ? '' : id)]),
    resumeOrders: () => call('resumeOrders', []),
    removeAlert: (id) => call('removeAlert', [str(id === undefined ? '' : id)]),
    muteAlert: (id, muted) => call('muteAlert', [str(id === undefined ? '' : id), muted !== false]),
    clearFiredAlerts: () => call('clearFiredAlerts', []),
    saveTemplate: (tpl) => call('saveTemplate', [tpl && typeof tpl === 'object' ? tpl : {}]),
    deleteTemplate: (id) => call('deleteTemplate', [str(id === undefined ? '' : id)]),
    setActiveTemplate: (id) => call('setActiveTemplate', [id === null || id === undefined ? null : str(id)]),
    settings: () => call('settings', []),
    positions: () => call('positions', []),
    orders: (mint) => call('orders', mint === undefined ? [] : [mint]),
    runners: () => call('runners', []),
    leaders: () => call('leaders', []),
    wallet: () => call('wallet', []),
    getState: () => call('getState', []),
    setState: (obj) => call('setState', [obj]),
    disable: (reason) => call('disable', [str(reason || 'disabled by the script')]),
    now: () => Date.now(),
    /** 'solana' | 'robinhood' | 'bnb' \u2014 the chain this script runs on. */
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
        // throws "await is only valid in async functions" at load \u2014 an
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
      // A timer's own handler; a tick with no id (an older main) runs them all.
      if (m.name === 'interval') {
        const tid = m.payload && m.payload.id;
        if (tid && timerHandlers.has(tid)) list.push(timerHandlers.get(tid));
        else if (!tid) list.push(...timerHandlers.values());
      }
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

// electron/system/scriptSandbox.ts
var CHANNEL = "script-sandbox";
var PARTITION = "script-sandbox";
var MSG_BURST = 120;
var MSG_PER_SEC = 60;
var boxes = /* @__PURE__ */ new Map();
var byContents = /* @__PURE__ */ new Map();
var buckets = /* @__PURE__ */ new Map();
var bucketKey = (contentsId, kind) => `${contentsId}:${kind}`;
var host = null;
var installed = false;
var generation = 0;
var preloadPath = null;
function _setPreloadPath(p) {
  preloadPath = p;
}
var failNextLoad = false;
function _failNextLoad() {
  failNextLoad = true;
}
function install(h) {
  host = h;
  if (installed) return;
  installed = true;
  const ses = import_electron.session.fromPartition(PARTITION);
  ses.webRequest.onBeforeRequest((details, callback) => {
    const isOwnPage = details.resourceType === "mainFrame" && details.url.startsWith("data:text/html");
    callback({ cancel: !isOwnPage });
  });
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  void ses.setProxy({ mode: "direct" }).catch(() => void 0);
  import_electron.ipcMain.on(CHANNEL, (event, raw) => {
    const scriptId = byContents.get(event.sender.id);
    if (!scriptId) return;
    const box = boxes.get(scriptId);
    if (!box) return;
    const kind = typeof raw === "object" && raw !== null ? raw.t : void 0;
    if (kind !== "ready" && kind !== "done" && !allow(box, kind === "call" ? "calls" : "chatter")) {
      const id = kind === "call" ? raw.id : void 0;
      if (typeof id === "number" && Number.isInteger(id) && id >= 0 && id < 2 ** 31) {
        post(box, { t: "reply", id, ok: false, error: `dropped: over ${MSG_PER_SEC} calls a second from this script \u2014 slow down (price in batches)` });
      }
      return;
    }
    const msg = parseFromSandbox(raw);
    if (!msg) {
      host?.log("warn", `script ${scriptId}: dropped a malformed sandbox message`);
      return;
    }
    if (msg.t === "alive") {
      box.alive = true;
      for (const w of box.aliveWaiters.splice(0)) w();
    } else if (msg.t === "ready") {
      box.ready = true;
      for (const w of box.readyWaiters.splice(0)) w(true, "");
    } else if (msg.t === "error" && !box.ready) {
      for (const w of box.readyWaiters.splice(0)) w(false, msg.line);
    } else if (msg.t === "done") {
      box.inflight.get(msg.id)?.onDone({ ok: msg.ok, error: msg.error });
    }
    host?.onMessage(scriptId, msg);
  });
}
function allow(box, kind) {
  const now = Date.now();
  const key = bucketKey(box.contentsId, kind);
  let b = buckets.get(key);
  if (!b) {
    b = { tokens: MSG_BURST, last: now, dropped: 0, reported: false };
    buckets.set(key, b);
  }
  b.tokens = Math.min(MSG_BURST, b.tokens + (now - b.last) / 1e3 * MSG_PER_SEC);
  b.last = now;
  if (b.tokens >= 1) {
    b.tokens -= 1;
    if (b.tokens >= MSG_BURST - 1 && b.reported) {
      host?.log("info", `script ${box.scriptId}: message flood over \u2014 ${b.dropped} dropped`);
      b.reported = false;
      b.dropped = 0;
    }
    return true;
  }
  b.dropped += 1;
  if (!b.reported) {
    b.reported = true;
    const what = kind === "calls" ? "calls" : "log/stat messages";
    host?.log("warn", `script ${box.scriptId}: over ${MSG_PER_SEC} sandbox ${what} a second \u2014 dropping the excess`);
    host?.onMessage(box.scriptId, {
      t: "error",
      line: kind === "calls" ? `flooded the sandbox channel (over ${MSG_PER_SEC} calls a second) \u2014 the excess calls are refused ("dropped: \u2026"); make fewer at once` : `flooded the sandbox channel (over ${MSG_PER_SEC} log/stat messages a second) \u2014 the excess lines are dropped`
    });
  }
  return false;
}
function isRunning(scriptId) {
  const b = boxes.get(scriptId);
  return !!b && b.ready && !b.contents.isDestroyed();
}
function memoryMB(scriptId) {
  const b = boxes.get(scriptId);
  if (!b || b.contents.isDestroyed()) return null;
  try {
    const pid = b.contents.getOSProcessId();
    const kb = import_electron.app.getAppMetrics().find((m) => m.pid === pid)?.memory?.workingSetSize;
    return typeof kb === "number" && Number.isFinite(kb) ? Math.round(kb / 1024) : null;
  } catch {
    return null;
  }
}
async function start(scriptId, code, info) {
  await stop(scriptId, "restart");
  let win;
  try {
    win = new import_electron.BrowserWindow({
      show: false,
      width: 200,
      height: 100,
      webPreferences: {
        preload: preloadPath ?? import_node_path.default.join(__dirname, "scriptPreload.js"),
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        devTools: false,
        backgroundThrottling: false,
        images: false,
        webgl: false
      }
    });
  } catch (err) {
    return { ok: false, message: `sandbox window: ${err.message}`, retryable: true };
  }
  const contents = win.webContents;
  const box = {
    scriptId,
    win,
    contents,
    contentsId: contents.id,
    gen: ++generation,
    alive: false,
    aliveWaiters: [],
    ready: false,
    readyWaiters: [],
    preloadError: null,
    killedBy: null,
    inflight: /* @__PURE__ */ new Map(),
    nextEventId: 1
  };
  boxes.set(scriptId, box);
  byContents.set(box.contentsId, scriptId);
  try {
    contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
  } catch {
  }
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (e) => e.preventDefault());
  contents.on("preload-error", (_e, preloadPath2, err) => {
    box.preloadError = `${import_node_path.default.basename(preloadPath2)}: ${err?.message ?? String(err)}`;
    host?.log("error", `script ${scriptId}: sandbox preload failed to load \u2014 ${box.preloadError}`);
  });
  const gone = (reason) => {
    const mine = boxes.get(scriptId) === box;
    teardown(box);
    if (mine) host?.onGone(scriptId, reason);
  };
  contents.on("render-process-gone", (_e, d) => gone(box.killedBy ? box.killedBy : `the renderer stopped (${d.reason})`));
  win.on("closed", () => gone("closed"));
  const superseded = () => boxes.get(scriptId) !== box;
  try {
    if (failNextLoad) {
      failNextLoad = false;
      throw new Error("ERR_FAILED (-2) (test)");
    }
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sandboxPageHtml())}`);
  } catch (err) {
    teardown(box);
    return { ok: false, message: `sandbox load: ${err.message}`, retryable: true };
  }
  if (superseded()) {
    teardown(box);
    return { ok: false, message: `superseded by a newer start (#${box.gen} \u2192 #${generation})` };
  }
  if (contents.isDestroyed()) {
    teardown(box);
    return { ok: false, message: "sandbox closed while loading", retryable: true };
  }
  if (!box.alive) {
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, ALIVE_TIMEOUT_MS);
      box.aliveWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  if (superseded()) {
    teardown(box);
    return { ok: false, message: `superseded by a newer start (#${box.gen} \u2192 #${generation})` };
  }
  if (!box.alive) {
    const why = box.preloadError ? `the sandbox preload failed to load (${box.preloadError}) \u2014 this is a broken install, not a problem with your script` : `the sandbox bridge never loaded (no signal in ${ALIVE_TIMEOUT_MS} ms) \u2014 this is a broken install, not a problem with your script`;
    teardown(box);
    host?.log("error", `script ${scriptId}: ${why}`);
    return { ok: false, message: why, retryable: true };
  }
  post(box, { t: "init", scriptId, code, chain: info?.chain, nativeSymbol: info?.nativeSymbol, inputs: info?.inputs });
  const startedAt = Date.now();
  let ready = null;
  for (; ; ) {
    ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, why: "timeout" }), READY_TIMEOUT_MS);
      box.readyWaiters.push((ok, why) => {
        clearTimeout(timer);
        resolve({ ok, why });
      });
    });
    if (superseded()) {
      teardown(box);
      return { ok: false, message: `superseded by a newer start (#${box.gen} \u2192 #${generation})` };
    }
    if (ready.ok || ready.why !== "timeout") break;
    if (contents.isDestroyed()) break;
    const elapsed = Date.now() - startedAt;
    const breathing = await probeAlive(contents);
    if (!breathing || elapsed >= READY_MAX_MS) {
      const why = breathing ? `the script's own top-level code did not finish within ${Math.round(READY_MAX_MS / 1e3)} s` : `the sandbox stopped responding while loading the script (${Math.round(elapsed / 1e3)} s)`;
      teardown(box);
      host?.log("warn", `script ${scriptId}: ${why}`);
      return { ok: false, message: why, retryable: breathing };
    }
    host?.log("info", `script ${scriptId}: still starting after ${Math.round(elapsed / 1e3)} s \u2014 its top-level code is waiting on something, the sandbox is healthy`);
  }
  if (!ready.ok) {
    teardown(box);
    host?.log("info", `script ${scriptId}: sandbox failed to start (${ready.why})`);
    return { ok: false, message: ready.why };
  }
  return { ok: true, message: "running" };
}
async function probeAlive(contents) {
  return probeResponsive({
    ask: () => contents.executeJavaScript("0"),
    gone: () => contents.isDestroyed()
  });
}
function dispatch(scriptId, name, payload) {
  const box = boxes.get(scriptId);
  if (!box || !box.ready || box.contents.isDestroyed()) return Promise.resolve({ ok: false, error: "not running" });
  const id = box.nextEventId++;
  return new Promise((resolve) => {
    let settled = false;
    let probing = false;
    const settle = (r) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const startedAt = Date.now();
    let timer;
    let extended = false;
    let cleared = false;
    const onDeadline = async () => {
      if (cleared || box.contents.isDestroyed()) return;
      const waited = Date.now() - startedAt;
      const alive = waited < EVENT_HARD_MS ? await probeAlive(box.contents) : false;
      if (cleared || box.contents.isDestroyed()) return;
      if (alive) {
        if (!extended) {
          extended = true;
          host?.log(
            "info",
            `script ${scriptId}: the "${name}" handler is still waiting after ${Math.round(waited / 1e3)}s \u2014 it is responsive, so it is waiting on something rather than stuck. Letting it finish (up to ${EVENT_HARD_MS / 1e3}s).`
          );
        }
        timer = setTimeout(() => void onDeadline(), EVENT_TIMEOUT_MS);
        if (box.inflight.get(id) === entry) entry.timer = timer;
        return;
      }
      box.inflight.delete(id);
      const secs = Math.round((Date.now() - startedAt) / 1e3);
      settle({ ok: false, error: `handler for "${name}" ran past ${secs} s \u2014 killed` });
      kill(
        box,
        scriptId,
        waited >= EVENT_HARD_MS ? `your "${name}" handler was still going after ${secs}s, so the script was restarted \u2014 anything it held in memory is gone (use bot.setState to keep it)` : `your "${name}" handler stopped responding \u2014 it is most likely stuck in a loop. The script was restarted and anything it held in memory is gone (use bot.setState to keep it).`
      );
    };
    timer = setTimeout(() => void onDeadline(), EVENT_TIMEOUT_MS);
    const clear = () => {
      cleared = true;
      clearTimeout(entry ? entry.timer : timer);
      if (box.inflight.get(id) === entry) box.inflight.delete(id);
    };
    const onDone = (r) => {
      settle(r);
      if (probing) return;
      probing = true;
      try {
        void box.contents.executeJavaScript("0").then(clear, clear);
      } catch {
        clear();
      }
    };
    const entry = { settle, timer, onDone };
    entry.timer = timer;
    box.inflight.set(id, entry);
    post(box, { t: "event", id, name, payload });
  });
}
function kill(box, scriptId, why) {
  box.killedBy = why;
  try {
    if (!box.contents.isDestroyed()) box.contents.forcefullyCrashRenderer();
    else void stop(scriptId, "watchdog");
  } catch {
    void stop(scriptId, "watchdog");
  }
}
function reply(scriptId, id, ok, value, error) {
  const box = boxes.get(scriptId);
  if (!box || box.contents.isDestroyed()) return;
  post(box, { t: "reply", id, ok, value, error });
}
async function stop(scriptId, reason = "stopped") {
  const box = boxes.get(scriptId);
  if (!box) return;
  teardown(box);
  host?.log("info", `script ${scriptId}: sandbox ${reason}`);
}
async function stopAll() {
  for (const id of [...boxes.keys()]) await stop(id, "shutdown");
}
function teardown(box) {
  if (boxes.get(box.scriptId) === box) boxes.delete(box.scriptId);
  byContents.delete(box.contentsId);
  buckets.delete(bucketKey(box.contentsId, "chatter"));
  buckets.delete(bucketKey(box.contentsId, "calls"));
  for (const [, p] of box.inflight) {
    clearTimeout(p.timer);
    p.settle({ ok: false, error: "sandbox stopped" });
  }
  box.inflight.clear();
  for (const w of box.readyWaiters.splice(0)) w(false, "sandbox stopped");
  try {
    if (!box.win.isDestroyed()) box.win.destroy();
  } catch {
  }
}
function post(box, msg) {
  try {
    const wc = box.contents;
    if (!wc.isDestroyed()) wc.send(CHANNEL, msg);
  } catch {
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  _failNextLoad,
  _setPreloadPath,
  dispatch,
  install,
  isRunning,
  memoryMB,
  reply,
  start,
  stop,
  stopAll
});
