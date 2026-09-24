// The MCP listener — one loopback HTTP endpoint an AI client speaks JSON-RPC to.
//
// Hand-written rather than pulled from the SDK, for the reasons this repo
// always hand-writes its wire formats: the app is bytecode-hardened and
// electron-pinned, a new dependency in the process that holds the signing key
// is a new thing to trust, and the subset a tools-only server needs is six
// methods. Every frame is pinned against a real socket in
// test/mcpserver.test.mjs.
//
// TWO ERAS ON ONE ENDPOINT. Up to 2025-11-25 a client opens with `initialize`,
// negotiates a version and echoes a session id. From 2026-07-28 there is no
// handshake and no session: each request carries its own version in `_meta`,
// repeats its method and target in headers, and discovery is `server/discover`.
// The spec allows serving both on one path and this does, because today's
// clients send the old handshake while the current spec is the new one. The
// era of a request is read off the request itself (see `eraOf`), never
// configured.
//
// SECURITY, which is the point of the file:
//
//   1. It binds 127.0.0.1 and nothing else. There is no setting that makes it
//      listen on a routable address, because a trading app reachable from the
//      network is a different product.
//   2. Every request needs `Authorization: Bearer <token>` matching the token
//      generated in main, compared in constant time over a digest so neither
//      the value nor its length leaks.
//   3. The `Origin` header is validated and a bad one is 403, as the spec
//      requires by name. A browser can reach a loopback port, so without this
//      any page the user has open could drive their wallet — the DNS
//      rebinding hole. Refused whatever the token says.
//   4. Bodies are capped, so a request cannot exhaust memory.
//   5. `access` is read per request, so the switch in the app stops the next
//      CALL rather than the next connection.
//
// What it is not: a general HTTP server. One path, six methods, and no route
// that reads a file, proxies a URL or reflects input.

import http from 'node:http';
import crypto from 'node:crypto';
import {
  JSONRPC_INTERNAL_ERROR,
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  JSONRPC_PARSE_ERROR,
  MCP_HEADER_MISMATCH,
  MCP_INSTRUCTIONS,
  MCP_MISSING_CAPABILITY,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_VERSIONS,
  MCP_TOKEN_CHARS,
  MCP_UNSUPPORTED_VERSION,
  META_CLIENT_CAPABILITIES,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  isModernVersion,
  toolAllowed,
  toolsFor,
  type McpAccess,
} from '@shared/mcp';

/** The one path. Anything else is a 404 with no detail. */
const PATH = '/mcp';
/** Bodies above this are refused unread. A tool call is a few hundred bytes. */
const MAX_BODY = 256 * 1024;
/** Legacy sessions idle longer than this are forgotten. */
const SESSION_TTL_MS = 6 * 3_600_000;
const SERVER_VERSION = '1';
/** How long a client may cache the tool list. See `tools/list`. */
const TOOLS_TTL_MS = 60_000;

export interface McpToolOutcome {
  /** False marks the result `isError` for the client — a refusal the model
   *  should read and adjust to, not a crash. */
  ok: boolean;
  /** What the agent reads. Always present, always plain words. */
  text: string;
  /** The same answer as data, when there is one. */
  data?: unknown;
}

export interface McpServerHost {
  /** Current access level, read on EVERY request. */
  access(): McpAccess;
  /** The bearer token that must match. Empty = refuse everything. */
  token(): string;
  /** Run a tool. Never throws: a failure is an outcome with ok:false. */
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolOutcome>;
  log(level: 'info' | 'warn' | 'error', line: string): void;
  /** Told when a client identifies itself, for the panel and the log. */
  onClient?(info: { name: string; version: string }): void;
}

export interface McpStatus {
  running: boolean;
  port: number | null;
  /** Legacy clients that completed `initialize` and are not yet forgotten. */
  sessions: number;
  lastClient: string | null;
  lastCallAt: number | null;
  calls: number;
  refusals: number;
  message: string;
}

interface Session {
  id: string;
  client: string;
  lastSeen: number;
}

let server: http.Server | null = null;
let host: McpServerHost | null = null;
let boundPort: number | null = null;
let message = '';
const sessions = new Map<string, Session>();
let lastClient: string | null = null;
let lastCallAt: number | null = null;
let calls = 0;
let refusals = 0;

export function newToken(): string {
  return crypto.randomBytes(MCP_TOKEN_CHARS / 2).toString('hex');
}

export function status(): McpStatus {
  return { running: server !== null, port: boundPort, sessions: sessions.size, lastClient, lastCallAt, calls, refusals, message };
}

export function isRunning(): boolean {
  return server !== null;
}

/**
 * Start listening. Idempotent for the same port; a different port restarts.
 * Resolves once the socket is bound or the bind has failed — the caller is a
 * settings handler and the user is waiting to be told which it was.
 */
export function start(h: McpServerHost, port: number): Promise<{ ok: boolean; message: string }> {
  host = h;
  if (server && boundPort === port) return Promise.resolve({ ok: true, message: `Already listening on ${port}` });
  if (server) stop();
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => void handle(req, res));
    s.on('error', (err) => {
      const why =
        (err as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ? `port ${port} is already in use — pick another`
          : ((err as Error).message ?? 'could not listen');
      message = why;
      h.log('warn', `MCP: ${why}`);
      if (server === s) {
        server = null;
        boundPort = null;
      }
      resolve({ ok: false, message: why });
    });
    // 127.0.0.1 explicitly. Not '::', not '0.0.0.0', not a setting.
    s.listen(port, '127.0.0.1', () => {
      server = s;
      // What the OS actually gave us, not what we asked for: port 0 means
      // 'any free one', and a status that echoed the request would report a
      // port nothing is listening on.
      const addr = s.address();
      boundPort = typeof addr === 'object' && addr !== null ? addr.port : port;
      message = '';
      h.log('info', `MCP: listening on 127.0.0.1:${port} — connect an AI client with the token from Settings`);
      resolve({ ok: true, message: `Listening on 127.0.0.1:${port}` });
    });
  });
}

export function stop(): void {
  const s = server;
  server = null;
  boundPort = null;
  sessions.clear();
  if (!s) return;
  try {
    s.close();
    // Node keeps a closed server alive until every keep-alive socket drains,
    // and an AI client holds one open between calls — so a stop that waited
    // for them is a stop the user watches not happen.
    s.closeAllConnections?.();
  } catch {
    /* already gone */
  }
  host?.log('info', 'MCP: stopped listening');
}

/** Constant-time compare over digests, so neither value nor length leaks. */
function tokenMatches(given: string, want: string): boolean {
  if (!want || !given) return false;
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Is this Origin one a local tool would send?
 *
 * No Origin at all is a program (an MCP client, curl). An Origin means a
 * browser, and the only browser origin that may drive a wallet is a page
 * served from loopback. Anything else is the rebinding case: an attacker's
 * page resolves a name to 127.0.0.1 and posts here.
 */
function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]' || u.hostname === '::1';
  } catch {
    return false;
  }
}

function send(res: http.ServerResponse, code: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === null ? '' : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
    // Belt and braces beside the Origin check: no browser may read a reply.
    'access-control-allow-origin': 'null',
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

const rpcError = (id: unknown, code: number, msg: string, data?: unknown): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: data === undefined ? { code, message: msg } : { code, message: msg, data },
});

/**
 * The body, or null when it is too big.
 *
 * An oversized body is DISCARDED as it arrives rather than destroying the
 * socket: memory stays bounded either way, but a client that is hung up on
 * mid-request sees a transport failure instead of the 413 that tells it what
 * it did wrong. Reading and dropping costs nothing and answers honestly.
 */
function readBody(req: http.IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        tooBig = true;
        chunks.length = 0;
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => resolve(tooBig ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(null));
  });
}

function sweepSessions(now: number): void {
  for (const [id, s] of sessions) if (now - s.lastSeen > SESSION_TTL_MS) sessions.delete(id);
}

/** What one JSON-RPC message turned into. */
interface Answer {
  /** The object to return, or null for a notification (nothing is sent). */
  body: unknown | null;
  /** A status this message forces on the whole response. */
  status?: number;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const h = host;
  if (!h) return send(res, 503, { error: 'not ready' });
  const url = (req.url ?? '').split('?')[0];
  if (url !== PATH) return send(res, 404, { error: 'not found' });

  if (!originAllowed(req.headers.origin as string | undefined)) {
    refusals += 1;
    h.log('warn', `MCP: refused a request from origin ${String(req.headers.origin)} — only loopback origins may reach this port`);
    // The spec's own shape for this: an error response with no id.
    return send(res, 403, rpcError(null, JSONRPC_INVALID_REQUEST, 'origin not allowed'));
  }

  // Auth before anything is parsed, and the same answer whether the header is
  // missing, malformed or wrong.
  const auth = String(req.headers.authorization ?? '');
  const given = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';
  if (!tokenMatches(given, h.token())) {
    refusals += 1;
    return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  }

  if (h.access() === 'off') {
    refusals += 1;
    return send(res, 503, { error: 'the AI connection is switched off in the app' });
  }

  const now = Date.now();
  sweepSessions(now);
  const sessionId = String(req.headers['mcp-session-id'] ?? '');

  if (req.method === 'DELETE') {
    // Legacy session teardown. A modern client sends no session and gets the
    // 405 the modern spec asks for.
    if (!sessionId) return send(res, 405, { error: 'no session to end' }, { allow: 'POST, DELETE' });
    sessions.delete(sessionId);
    return send(res, 204, null);
  }
  if (req.method === 'GET') {
    // Both eras let a server with nothing to push refuse the stream. This one
    // answers requests and initiates nothing, so it does.
    return send(res, 405, { error: 'this server does not open a server-to-client stream' }, { allow: 'POST, DELETE' });
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });

  const raw = await readBody(req);
  if (raw === null) return send(res, 413, rpcError(null, JSONRPC_INVALID_REQUEST, 'request body too large'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return send(res, 400, rpcError(null, JSONRPC_PARSE_ERROR, 'invalid JSON'));
  }

  // A session id this process does not know is GONE, not forbidden: 404 tells
  // a legacy client to start a new one rather than give up. Checked after the
  // body parses so a modern request, which carries no session, is unaffected.
  if (sessionId) {
    const s = sessions.get(sessionId);
    if (!s) return send(res, 404, rpcError(null, JSONRPC_INVALID_REQUEST, 'unknown session'));
    s.lastSeen = now;
  }

  const batch = Array.isArray(parsed);
  const items = (batch ? parsed : [parsed]) as unknown[];
  if (batch && items.length === 0) return send(res, 400, rpcError(null, JSONRPC_INVALID_REQUEST, 'empty batch'));
  const out: unknown[] = [];
  let newSession: string | null = null;
  let status = 200;
  for (const item of items) {
    const a = await dispatch(h, item, req, () => {
      if (!newSession) newSession = crypto.randomUUID();
      return newSession;
    });
    if (a.status && a.status !== 200) status = a.status;
    if (a.body !== null) out.push(a.body);
  }
  const headers: Record<string, string> = newSession ? { 'mcp-session-id': newSession } : {};
  // Notifications only: 202 with no body, as JSON-RPC requires.
  if (!out.length) return send(res, 202, null, headers);
  return send(res, status, batch ? out : out[0], headers);
}

/**
 * Which era is this message written in? Decided by the message, never set.
 *
 * `_meta` travels inside `params`, NOT at the top level of the JSON-RPC
 * object — verified 2026-09-21 against what Claude Code 2.1.278 actually
 * sends. Reading it from the top level made every modern request look legacy,
 * so `tools/list` came back without `resultType` and a real client refused
 * the whole server: "missing required resultType". The top level is still
 * accepted as a fallback, since nothing is lost by taking it from either.
 */
function eraOf(params: Record<string, unknown>, top: Record<string, unknown> | null): { modern: boolean; version: string; meta: Record<string, unknown> | null } {
  const inParams = typeof params._meta === 'object' && params._meta !== null ? (params._meta as Record<string, unknown>) : null;
  const meta = inParams ?? top;
  const v = meta && typeof meta[META_PROTOCOL_VERSION] === 'string' ? (meta[META_PROTOCOL_VERSION] as string) : '';
  return v ? { modern: true, version: v, meta } : { modern: false, version: '', meta };
}

/** One JSON-RPC message in, one answer out. */
async function dispatch(h: McpServerHost, msg: unknown, req: http.IncomingMessage, openSession: () => string): Promise<Answer> {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
    return { body: rpcError(null, JSONRPC_INVALID_REQUEST, 'not a JSON-RPC object'), status: 400 };
  }
  const m = msg as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown; _meta?: unknown };
  if (m.jsonrpc !== '2.0') return { body: rpcError(m.id, JSONRPC_INVALID_REQUEST, 'jsonrpc must be "2.0"'), status: 400 };
  if (typeof m.method !== 'string') return { body: rpcError(m.id, JSONRPC_INVALID_REQUEST, 'method must be a string'), status: 400 };
  const notification = m.id === undefined || m.id === null;
  const params = (typeof m.params === 'object' && m.params !== null && !Array.isArray(m.params) ? m.params : {}) as Record<string, unknown>;
  const era = eraOf(params, (typeof m._meta === 'object' && m._meta !== null ? m._meta : null) as Record<string, unknown> | null);
  const meta = era.meta;
  const method = m.method;

  // ── Modern-era preconditions ───────────────────────────────────────
  //
  // A modern request states its version in the body, repeats it and its
  // method in headers so a proxy can route without parsing, and declares what
  // the client can do. Each of those is required, and each has its own code.
  if (era.modern) {
    if (!MCP_SUPPORTED_VERSIONS.includes(era.version)) {
      return {
        body: rpcError(m.id, MCP_UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: MCP_SUPPORTED_VERSIONS, requested: era.version }),
        status: 400,
      };
    }
    const headerVersion = String(req.headers['mcp-protocol-version'] ?? '');
    if (headerVersion && headerVersion !== era.version) {
      return { body: rpcError(m.id, MCP_HEADER_MISMATCH, 'MCP-Protocol-Version does not match the version in _meta'), status: 400 };
    }
    const headerMethod = String(req.headers['mcp-method'] ?? '');
    if (headerMethod && headerMethod !== method) {
      return { body: rpcError(m.id, MCP_HEADER_MISMATCH, 'Mcp-Method does not match the method in the body'), status: 400 };
    }
    if (method === 'tools/call') {
      const headerName = String(req.headers['mcp-name'] ?? '');
      if (headerName && headerName !== String(params.name ?? '')) {
        return { body: rpcError(m.id, MCP_HEADER_MISMATCH, 'Mcp-Name does not match params.name'), status: 400 };
      }
    }
    // Capabilities are required on every modern request, not once at a
    // handshake there no longer is.
    if (meta && meta[META_CLIENT_CAPABILITIES] === undefined && method !== 'ping') {
      return { body: rpcError(m.id, MCP_MISSING_CAPABILITY, `_meta must carry ${META_CLIENT_CAPABILITIES}`), status: 400 };
    }
  }

  /** A modern result says it is finished; a legacy one has no such field. */
  const ok = (result: Record<string, unknown>): Answer => ({
    body: { jsonrpc: '2.0', id: m.id ?? null, result: era.modern ? { ...result, resultType: 'complete' } : result },
  });

  const noteClient = (name: string, version: string): void => {
    lastClient = name;
    h.log('info', `MCP: ${name}${version ? ` ${version}` : ''} connected — ${h.access()} access`);
    h.onClient?.({ name, version });
  };
  const clientName = (): { name: string; version: string } => {
    const raw = (typeof params.clientInfo === 'object' && params.clientInfo !== null ? params.clientInfo : meta?.['io.modelcontextprotocol/clientInfo']) as
      | { name?: unknown; version?: unknown }
      | undefined;
    return {
      name: typeof raw?.name === 'string' ? raw.name.slice(0, 60) : 'unknown client',
      version: typeof raw?.version === 'string' ? raw.version.slice(0, 30) : '',
    };
  };

  switch (method) {
    // ── Legacy handshake ─────────────────────────────────────────────
    case 'initialize': {
      if (notification) return { body: null };
      const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      // The spec: answer with THEIR version when we support it, else the
      // latest we do. A modern client never gets here, so the fallback is the
      // newest legacy version rather than the newest overall.
      const version = MCP_SUPPORTED_VERSIONS.includes(asked) && !isModernVersion(asked) ? asked : '2025-11-25';
      const who = clientName();
      const id = openSession();
      sessions.set(id, { id, client: who.name, lastSeen: Date.now() });
      noteClient(who.name, who.version);
      return ok({
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: 'Krypto Terminal', version: SERVER_VERSION },
        instructions: MCP_INSTRUCTIONS,
      });
    }
    // ── Modern discovery ─────────────────────────────────────────────
    case 'server/discover': {
      if (notification) return { body: null };
      const who = clientName();
      if (who.name !== 'unknown client') noteClient(who.name, who.version);
      return ok({
        supportedVersions: MCP_SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        instructions: MCP_INSTRUCTIONS,
        ttlMs: TOOLS_TTL_MS,
        cacheScope: 'private',
        _meta: { [META_SERVER_INFO]: { name: MCP_SERVER_NAME, title: 'Krypto Terminal', version: SERVER_VERSION } },
      });
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return { body: null };
    case 'ping':
      return notification ? { body: null } : ok({});
    case 'tools/list': {
      if (notification) return { body: null };
      // Deterministic order, and the same set for every connection at a given
      // access level — the modern spec requires both.
      const tools = toolsFor(h.access()).map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        annotations: {
          title: t.title,
          readOnlyHint: t.readOnly,
          destructiveHint: t.destructive,
          idempotentHint: false,
          // Every tool here reaches a chain or a provider, never a closed set.
          openWorldHint: true,
        },
      }));
      // `ttlMs` and `cacheScope` are REQUIRED of a modern tools/list result —
      // a real client validates both and refuses the server without them
      // (measured 2026-09-21). The scope is `private` because the set depends
      // on THIS connection's access level: a shared cache would hand one
      // user's live tool list to a read-only one. The TTL is a minute, which
      // is how long a stale list may survive the user changing that level.
      return ok(era.modern ? { tools, ttlMs: TOOLS_TTL_MS, cacheScope: 'private' } : { tools });
    }
    case 'tools/call': {
      if (notification) return { body: null };
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments) ? params.arguments : {}) as Record<
        string,
        unknown
      >;
      const gate = toolAllowed(name, h.access());
      if (!gate.ok) {
        refusals += 1;
        // An agent reaching for a tool its connection does not allow is the
        // most interesting line in the whole audit trail, and it never
        // reached the host's logging because the gate refuses first
        // (2026-09-21). Logged HERE, where the refusal actually happens.
        h.log('warn', `AI tried ${name || '(no name)'} → REFUSED: ${gate.reason}`);
        // The spec's own division: a name that does not exist is a PROTOCOL
        // error, because the model cannot fix it by trying again. A tool that
        // exists but is switched off is a RESULT, because the reason is
        // something the model should read and work around.
        if (!toolsFor('live').some((t) => t.name === name)) {
          return { body: rpcError(m.id, JSONRPC_INVALID_PARAMS, gate.reason) };
        }
        return ok({ content: [{ type: 'text', text: gate.reason }], isError: true });
      }
      calls += 1;
      lastCallAt = Date.now();
      let outcome: McpToolOutcome;
      try {
        outcome = await h.callTool(name, args);
      } catch (e) {
        h.log('warn', `MCP: ${name} failed — ${(e as Error).message}`);
        return { body: rpcError(m.id, JSONRPC_INTERNAL_ERROR, 'the app could not answer that') };
      }
      if (!outcome.ok) refusals += 1;
      // Structured data goes back BOTH ways: as `structuredContent` for a
      // client that parses, and serialised into the text block beneath the
      // sentence, which is what the spec asks for and what a model reads.
      const text = outcome.data === undefined ? outcome.text : `${outcome.text}\n\n${JSON.stringify(outcome.data, null, 2)}`;
      const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: !outcome.ok };
      if (outcome.data !== undefined) result.structuredContent = outcome.data;
      return ok(result);
    }
    default:
      // Modern says an unknown method is 404 as well as -32601; legacy leaves
      // the status alone.
      return notification
        ? { body: null }
        : { body: rpcError(m.id, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${method}`), status: era.modern ? 404 : 200 };
  }
}

/** Test seam. */
export function _reset(): void {
  stop();
  sessions.clear();
  host = null;
  lastClient = null;
  lastCallAt = null;
  calls = 0;
  refusals = 0;
  message = '';
}
