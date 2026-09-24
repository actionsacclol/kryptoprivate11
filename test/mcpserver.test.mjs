// The MCP listener (electron/system/mcpServer.ts), against a real socket.
//
// This is the door an AI agent comes through, so the checks here are the ones
// that keep it a door and not a hole: loopback only, a bearer token compared
// without leaking, a rejected Origin (the DNS-rebinding case the spec names),
// a body cap, and an access switch that is read per REQUEST rather than per
// connection. On top of that, both protocol eras on one endpoint — the
// `initialize` handshake today's clients send, and the 2026-07-28 shape that
// has no handshake at all.

import assert from 'node:assert';
import * as mcp from './.mcpserver.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const TOKEN = 'a'.repeat(64);
const MODERN = '2026-07-28';
const META_V = 'io.modelcontextprotocol/protocolVersion';
const META_CAPS = 'io.modelcontextprotocol/clientCapabilities';

let access = 'read';
const calls = [];
let toolAnswer = { ok: true, text: 'done', data: { hi: 1 } };
const host = {
  access: () => access,
  token: () => TOKEN,
  callTool: async (name, args) => {
    calls.push({ name, args });
    if (toolAnswer instanceof Error) throw toolAnswer;
    return toolAnswer;
  },
  log: () => {},
};

let port = 0;
const post = async (body, opts = {}) => {
  const headers = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (opts.token !== null) headers.authorization = `Bearer ${opts.token ?? TOKEN}`;
  const res = await fetch(`http://127.0.0.1:${port}${opts.path ?? '/mcp'}`, {
    method: opts.method ?? 'POST',
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* some replies have no body */
  }
  return { status: res.status, json, text, headers: res.headers };
};

const legacy = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const modern = (id, method, params, over = {}) => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params ? { params } : {}),
  _meta: { [META_V]: MODERN, [META_CAPS]: {}, ...(over.meta ?? {}) },
});
const modernHeaders = (method, name) => ({ 'mcp-protocol-version': MODERN, 'mcp-method': method, ...(name ? { 'mcp-name': name } : {}) });

// Ephemeral port: bind 0, read what the OS gave us.
{
  const r = await mcp.start(host, 0);
  assert.equal(r.ok, true, r.message);
  port = mcp.status().port;
  assert.ok(port > 0, 'bound to an ephemeral port');
}

// ── the guards ───────────────────────────────────────────────────────────
{
  assert.equal((await post(legacy(1, 'ping'), { token: null })).status, 401, 'no token, no answer');
  assert.equal((await post(legacy(1, 'ping'), { token: 'b'.repeat(64) })).status, 401, 'a wrong token of the same length');
  assert.equal((await post(legacy(1, 'ping'), { token: 'short' })).status, 401, 'and one of a different length');

  // The rebinding case: a browser page on any other origin.
  const evil = await post(legacy(1, 'ping'), { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403, 'a non-loopback Origin is refused before anything else');
  assert.equal(evil.json?.error?.code, -32600, 'and answered in the shape the spec asks for');
  assert.equal((await post(legacy(1, 'ping'), { headers: { origin: 'http://localhost:3000' } })).status, 200, 'a loopback origin is fine');
  assert.equal((await post(legacy(1, 'ping'), { headers: { origin: 'null' } })).status, 403, 'an unparseable origin is not waved through');

  assert.equal((await post(legacy(1, 'ping'), { path: '/' })).status, 404, 'there is one path and nothing else');
  assert.equal((await post(undefined, { method: 'GET' })).status, 405, 'no server-to-client stream is offered');
  assert.equal((await post('{not json', {})).status, 400, 'a malformed body is a parse error');
  assert.equal((await post('x'.repeat(300_000), {})).status, 413, 'and an oversized one never reaches the parser');
  ok('loopback door: a wrong or missing token, a foreign Origin, another path, a GET, junk and a huge body are all refused');
}

// ── the access switch is read per request ────────────────────────────────
{
  access = 'off';
  assert.equal((await post(legacy(1, 'ping'))).status, 503, 'switched off in the app, the next CALL stops — not the next connection');
  access = 'read';
  assert.equal((await post(legacy(1, 'ping'))).status, 200);
  ok('turning the connection off in the app takes effect on the very next request');
}

// ── legacy era: initialize, session, tools ───────────────────────────────
{
  const init = await post(legacy(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Claude Code', version: '2.0' } }));
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-11-25', 'a version we support is echoed back');
  assert.equal(init.json.result.serverInfo.name, 'krypto-terminal');
  assert.ok(init.json.result.capabilities.tools, 'tools are advertised');
  assert.match(init.json.result.instructions, /PAPER|paper/, 'the agent is told what paper means before it trades');
  const session = init.headers.get('mcp-session-id');
  assert.ok(session, 'a session id came back');
  assert.equal(mcp.status().lastClient, 'Claude Code');

  // A version we do not know gets the latest legacy one, not silence.
  const old = await post(legacy(2, 'initialize', { protocolVersion: '1999-01-01', capabilities: {} }));
  assert.equal(old.json.result.protocolVersion, '2025-11-25');

  // The session must be honoured, and an unknown one is 404 so the client
  // knows to start over rather than giving up.
  assert.equal((await post(legacy(3, 'ping'), { headers: { 'mcp-session-id': session } })).status, 200);
  assert.equal((await post(legacy(3, 'ping'), { headers: { 'mcp-session-id': 'nope' } })).status, 404);
  assert.equal((await post(undefined, { method: 'DELETE', headers: { 'mcp-session-id': session } })).status, 204);
  assert.equal((await post(legacy(3, 'ping'), { headers: { 'mcp-session-id': session } })).status, 404, 'and it is gone after DELETE');

  // A notification answers nothing at all.
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.equal(note.text, '');
  ok('legacy era: initialize negotiates, mints a session, honours it, forgets it on DELETE, and a notification answers 202 with no body');
}

// ── tools/list follows the access ladder ─────────────────────────────────
{
  access = 'read';
  const readOnly = (await post(legacy(4, 'tools/list'))).json.result.tools;
  assert.ok(readOnly.length > 0);
  assert.ok(
    readOnly.every((t) => t.annotations.readOnlyHint === true),
    'a read-only connection is shown only read tools',
  );
  assert.ok(!readOnly.some((t) => t.name === 'buy_token'));
  for (const t of readOnly) {
    assert.equal(t.inputSchema.type, 'object', 'every advertised schema is an object schema');
    assert.equal(t.annotations.openWorldHint, true, 'every tool reaches a chain or a provider');
  }

  access = 'live';
  const all = (await post(legacy(5, 'tools/list'))).json.result.tools;
  assert.ok(all.some((t) => t.name === 'buy_token'), 'live sees the trade tools');
  assert.equal(all.find((t) => t.name === 'sell_token').annotations.destructiveHint, true, 'a sell is marked destructive');
  assert.deepEqual(
    all.map((t) => t.name),
    (await post(legacy(6, 'tools/list'))).json.result.tools.map((t) => t.name),
    'the list is deterministic — the modern spec requires the same set every time',
  );
  ok('tools/list shows exactly what the access level allows, with honest annotations, in a deterministic order');
}

// ── tools/call: the gate, the result shape, the error shape ──────────────
{
  access = 'read';
  calls.length = 0;
  // A tool that EXISTS but is switched off is a RESULT the model can read and
  // work around, not a protocol error.
  const refused = await post(legacy(7, 'tools/call', { name: 'buy_token', arguments: { mint: 'x', amount: 1 } }));
  assert.equal(refused.status, 200);
  assert.equal(refused.json.result.isError, true);
  assert.match(refused.json.result.content[0].text, /read only/i);
  assert.equal(calls.length, 0, 'and it never reached the app');

  // A tool that does not exist is a protocol error: the model cannot fix it
  // by trying again with different arguments.
  const unknown = await post(legacy(8, 'tools/call', { name: 'drain_wallet', arguments: {} }));
  assert.equal(unknown.json.error.code, -32602);
  assert.match(unknown.json.error.message, /No such tool/);

  toolAnswer = { ok: true, text: 'Here it is.', data: { balanceSol: 1.5 } };
  const good = await post(legacy(9, 'tools/call', { name: 'get_wallet', arguments: {} }));
  assert.equal(good.json.result.isError, false);
  assert.deepEqual(good.json.result.structuredContent, { balanceSol: 1.5 }, 'data comes back structured for a client that parses');
  assert.match(good.json.result.content[0].text, /Here it is\./);
  assert.match(good.json.result.content[0].text, /"balanceSol": 1\.5/, 'and serialised into the text block, as the spec asks');
  assert.deepEqual(calls.at(-1), { name: 'get_wallet', args: {} });

  toolAnswer = { ok: false, text: 'That is above your limit.' };
  const softFail = await post(legacy(10, 'tools/call', { name: 'get_wallet', arguments: {} }));
  assert.equal(softFail.json.result.isError, true, 'a refusal from the app is an error RESULT');
  assert.equal(softFail.json.result.structuredContent, undefined);

  toolAnswer = new Error('boom');
  const hardFail = await post(legacy(11, 'tools/call', { name: 'get_wallet', arguments: {} }));
  assert.equal(hardFail.json.error.code, -32603, 'a throw is an internal error, and the message is not leaked');
  assert.equal(hardFail.json.error.message, 'the app could not answer that');
  toolAnswer = { ok: true, text: 'done' };
  ok('tools/call: a switched-off tool is an error result, an unknown one a protocol error, a throw never leaks its message');
}

// ── modern era: no handshake, headers must agree, discovery ──────────────
{
  access = 'live';
  const disc = await post(modern(20, 'server/discover'), { headers: modernHeaders('server/discover') });
  assert.equal(disc.status, 200);
  assert.ok(disc.json.result.supportedVersions.includes(MODERN));
  assert.equal(disc.json.result.resultType, 'complete', 'a modern result says it is finished');
  assert.equal(disc.json.result._meta['io.modelcontextprotocol/serverInfo'].name, 'krypto-terminal');
  assert.equal(disc.headers.get('mcp-session-id'), null, 'the modern era mints no session');

  // The headers exist so a proxy can route without parsing the body; if they
  // disagree with it, something has rewritten one of them.
  const badVersion = await post(modern(21, 'tools/list'), { headers: { ...modernHeaders('tools/list'), 'mcp-protocol-version': '2025-11-25' } });
  assert.equal(badVersion.status, 400);
  assert.equal(badVersion.json.error.code, -32020);
  const badMethod = await post(modern(22, 'tools/list'), { headers: { ...modernHeaders('tools/list'), 'mcp-method': 'tools/call' } });
  assert.equal(badMethod.json.error.code, -32020);
  const badName = await post(modern(23, 'tools/call', { name: 'get_wallet', arguments: {} }), { headers: modernHeaders('tools/call', 'buy_token') });
  assert.equal(badName.json.error.code, -32020, 'Mcp-Name must be the tool actually being called');

  // A version we do not speak is refused with the list we do.
  const future = await post({ jsonrpc: '2.0', id: 24, method: 'tools/list', _meta: { [META_V]: '2099-01-01', [META_CAPS]: {} } });
  assert.equal(future.status, 400);
  assert.equal(future.json.error.code, -32022);
  assert.ok(future.json.error.data.supported.includes(MODERN));
  assert.equal(future.json.error.data.requested, '2099-01-01');

  // Capabilities are required on every modern request, there being no
  // handshake to declare them once.
  const noCaps = await post({ jsonrpc: '2.0', id: 25, method: 'tools/list', _meta: { [META_V]: MODERN } });
  assert.equal(noCaps.json.error.code, -32021);

  // And the real thing works.
  const list = await post(modern(26, 'tools/list'), { headers: modernHeaders('tools/list') });
  assert.ok(list.json.result.tools.length > 0);
  assert.equal(list.json.result.resultType, 'complete');
  const unknownMethod = await post(modern(27, 'resources/list'), { headers: modernHeaders('resources/list') });
  assert.equal(unknownMethod.status, 404, 'the modern spec makes an unknown method a 404');
  assert.equal(unknownMethod.json.error.code, -32601);
  ok('modern era: server/discover answers, the three headers must match the body, a bad version and missing capabilities each get their own code');
}

// ── a REAL client's frames, captured 2026-09-21 ──────────────────────────
//
// Claude Code 2.1.278, recorded off the wire with a logging server. Two things
// here were wrong until a real client refused the whole server, and neither
// was visible against frames written from the spec prose:
//
//   1. `_meta` travels inside `params`, not at the top level of the JSON-RPC
//      object. Reading it from the top made every modern request look legacy,
//      so `tools/list` came back without `resultType` and the client said
//      "missing required resultType — servers implementing 2026-07-28 MUST
//      include it".
//   2. A modern `tools/list` result MUST carry `ttlMs` (a number) and
//      `cacheScope` ('public' | 'private'). The client validates both.
//
// These are the frames verbatim, so a future edit that breaks either fails
// here rather than in someone's terminal.
{
  access = 'read';
  const CLIENT_META = {
    'io.modelcontextprotocol/protocolVersion': MODERN,
    'io.modelcontextprotocol/clientInfo': { name: 'claude-code', title: 'Claude Code', version: '2.1.278' },
    'io.modelcontextprotocol/clientCapabilities': { roots: { listChanged: true }, elicitation: {} },
  };
  const asClaudeCode = (id, method, extra = {}) =>
    post({ jsonrpc: '2.0', id, method, params: { ...extra, _meta: CLIENT_META } }, { headers: { 'mcp-method': method, 'mcp-protocol-version': MODERN } });

  // Discovery, with a STRING id — the real client uses one.
  const disc = await asClaudeCode('server-discover-probe-1', 'server/discover');
  assert.equal(disc.status, 200);
  assert.equal(disc.json.id, 'server-discover-probe-1', 'a string id comes back unchanged');
  assert.equal(disc.json.result.resultType, 'complete');
  assert.ok(disc.json.result.supportedVersions.includes(MODERN));
  assert.equal(typeof disc.json.result.ttlMs, 'number');
  assert.ok(['public', 'private'].includes(disc.json.result.cacheScope));
  assert.equal(mcp.status().lastClient, 'claude-code', 'the client names itself inside params._meta, and we read it there');

  const list = await asClaudeCode(0, 'tools/list');
  assert.equal(list.json.result.resultType, 'complete', 'the era is read from params._meta — this is the bug a real client caught');
  assert.equal(typeof list.json.result.ttlMs, 'number', 'ttlMs is required of a modern list');
  assert.equal(list.json.result.cacheScope, 'private', 'and the scope is private: the set depends on THIS connection’s access level');
  assert.ok(list.json.result.tools.length > 0);

  // A tool call in the same shape, with Mcp-Name as the client sends it.
  toolAnswer = { ok: true, text: 'fine', data: { a: 1 } };
  const called = await post(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_wallet', arguments: {}, _meta: CLIENT_META } },
    { headers: { 'mcp-method': 'tools/call', 'mcp-name': 'get_wallet', 'mcp-protocol-version': MODERN } },
  );
  assert.equal(called.json.result.resultType, 'complete');
  assert.equal(called.json.result.isError, false);
  toolAnswer = { ok: true, text: 'done' };
  ok('the frames Claude Code 2.1.278 really sends: _meta inside params, a string id, and a list carrying ttlMs and cacheScope');
}

// ── batches ──────────────────────────────────────────────────────────────
{
  access = 'read';
  const batch = await post([legacy(30, 'ping'), { jsonrpc: '2.0', method: 'notifications/initialized' }, legacy(31, 'ping')]);
  assert.equal(batch.status, 200);
  assert.equal(batch.json.length, 2, 'the notification contributes no answer');
  assert.deepEqual(batch.json.map((x) => x.id), [30, 31]);
  assert.equal((await post([])).status, 400, 'an empty batch is not a request');
  ok('a batch answers only the messages that asked something, and an empty one is refused');
}

// ── stopping closes the port ─────────────────────────────────────────────
{
  mcp.stop();
  assert.equal(mcp.isRunning(), false);
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' });
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'the port is closed, not merely ignoring requests');
  mcp._reset();
  ok('stopping the connection closes the socket rather than leaving it open until a restart');
}

console.log(`\nmcpserver: ${passed}/9 passed`);
