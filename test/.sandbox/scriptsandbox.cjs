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
  _setPreloadPath: () => _setPreloadPath,
  dispatch: () => dispatch,
  install: () => install,
  isRunning: () => isRunning,
  reply: () => reply,
  start: () => start,
  stop: () => stop,
  stopAll: () => stopAll
});
module.exports = __toCommonJS(scriptSandbox_exports);
var import_electron = require("electron");
var import_node_path = __toESM(require("node:path"));

// shared/scriptProtocol.ts
var SCRIPT_METHODS = [
  "buy",
  "sell",
  "sellAll",
  "order",
  "cancelOrders",
  "templates",
  "applyTemplate",
  "alert",
  "watch",
  "unwatch",
  "subscribe",
  "unsubscribe",
  "notify",
  "price",
  "token",
  "market",
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
var ALIVE_TIMEOUT_MS = 4e3;
var READY_TIMEOUT_MS = 8e3;
var READY_MAX_MS = 3e4;
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
    buy: (mint, sol) => call('buy', [mint, sol]),
    sell: (mint, pct) => call('sell', [mint, pct]),
    sellAll: () => call('sellAll', []),
    order: (req) => call('order', [req]),
    cancelOrders: (mint) => call('cancelOrders', [mint]),
    templates: () => call('templates', []),
    applyTemplate: (mint, templateId) => call('applyTemplate', [mint, templateId]),
    alert: (req) => call('alert', [req]),
    watch: (mint) => call('watch', [mint]),
    unwatch: (mint) => call('unwatch', [mint]),
    subscribe: (mint) => call('subscribe', [mint]),
    unsubscribe: (mint) => call('unsubscribe', [mint]),
    notify: (message) => call('notify', [str(message)]),
    log: (...parts) => send({ t: 'log', level: 'info', line: parts.map(str).join(' ') }),
    warn: (...parts) => send({ t: 'log', level: 'warn', line: parts.map(str).join(' ') }),
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
var host = null;
var installed = false;
var generation = 0;
var preloadPath = null;
function _setPreloadPath(p) {
  preloadPath = p;
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
    if (kind !== "ready" && kind !== "done" && !allow(box)) return;
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
function allow(box) {
  const now = Date.now();
  let b = buckets.get(box.contentsId);
  if (!b) {
    b = { tokens: MSG_BURST, last: now, dropped: 0, reported: false };
    buckets.set(box.contentsId, b);
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
    host?.log("warn", `script ${box.scriptId}: over ${MSG_PER_SEC} sandbox messages a second \u2014 dropping the excess`);
    host?.onMessage(box.scriptId, {
      t: "error",
      line: `flooded the sandbox channel (over ${MSG_PER_SEC} messages a second) \u2014 messages are being dropped`
    });
  }
  return false;
}
function isRunning(scriptId) {
  const b = boxes.get(scriptId);
  return !!b && b.ready && !b.contents.isDestroyed();
}
async function start(scriptId, code) {
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
    return { ok: false, message: `sandbox window: ${err.message}` };
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
  contents.on("render-process-gone", (_e, d) => gone(`renderer ${d.reason}`));
  win.on("closed", () => gone("closed"));
  const superseded = () => boxes.get(scriptId) !== box;
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(sandboxPageHtml())}`);
  } catch (err) {
    teardown(box);
    return { ok: false, message: `sandbox load: ${err.message}` };
  }
  if (superseded()) {
    teardown(box);
    return { ok: false, message: `superseded by a newer start (#${box.gen} \u2192 #${generation})` };
  }
  if (contents.isDestroyed()) {
    teardown(box);
    return { ok: false, message: "sandbox closed while loading" };
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
  post(box, { t: "init", scriptId, code });
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
  if (contents.isDestroyed()) return false;
  return await new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const timer = setTimeout(() => done(false), 1e3);
    contents.executeJavaScript("0").then(() => {
      clearTimeout(timer);
      done(true);
    }).catch(() => {
      clearTimeout(timer);
      done(false);
    });
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
    const timer = setTimeout(() => {
      box.inflight.delete(id);
      settle({ ok: false, error: `handler for "${name}" ran past ${EVENT_TIMEOUT_MS} ms \u2014 killed` });
      kill(box, scriptId);
    }, EVENT_TIMEOUT_MS);
    const clear = () => {
      clearTimeout(timer);
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
    box.inflight.set(id, entry);
    post(box, { t: "event", id, name, payload });
  });
}
function kill(box, scriptId) {
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
  buckets.delete(box.contentsId);
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
  _setPreloadPath,
  dispatch,
  install,
  isRunning,
  reply,
  start,
  stop,
  stopAll
});
