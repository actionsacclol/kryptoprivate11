// The behaviour that follows from those rules, exercised through the real
// client: a 401 on the keyed endpoint must be answered by the public one,
// told to the user exactly once, and then not tried again until the key
// changes.
import assert from 'node:assert';
import {
  clearRpcRejections,
  getBalance,
  isEndpointRejected,
  noteSocketRejection,
  rpcCredentialsRejected,
  setRpcFallback,
} from './.rpcclient.mjs';

const KEY = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const KEYED = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const PUBLIC = 'https://api.mainnet-beta.solana.com';
const OWNER = 'So11111111111111111111111111111111111111112';

let hits = [];
function stubFetch(handler) {
  hits = [];
  globalThis.fetch = async (url) => {
    hits.push(url);
    return handler(url);
  };
}
const unauthorized = () => ({ ok: false, status: 401, json: async () => ({}) });
const serverError = () => ({ ok: false, status: 500, json: async () => ({}) });
const balance = (n) => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', result: { value: n } }) });

const notices = [];
const logs = [];
setRpcFallback(
  () => PUBLIC,
  (l) => logs.push(l),
  (l) => notices.push(l),
);

{
  clearRpcRejections();
  stubFetch((url) => (url === KEYED ? unauthorized() : balance(4200)));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.ok, true, 'the read succeeds despite the bad key');
  assert.equal(r.data, 4200, 'answered by the public endpoint');
  assert.deepEqual(hits, [KEYED, PUBLIC], 'one refused call, one failover — no pointless retry of a 401');
  console.log('ok  a refused key fails over instead of failing');
}

{
  assert.equal(notices.length, 1, 'the user is told once, not once per call');
  assert.ok(!notices[0].includes(KEY), 'and never shown their key');
  assert.match(notices[0], /Settings/);
  const state = rpcCredentialsRejected();
  assert.equal(state?.host, 'mainnet.helius-rpc.com');
  assert.equal(state?.code, '401');
  console.log('ok  one plain-English notice naming the host and the fix');
}

{
  // The second read must not spend a round trip on a certain 401.
  stubFetch(() => balance(77));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.data, 77);
  assert.deepEqual(hits, [PUBLIC], 'the rejected endpoint is skipped entirely');
  assert.equal(isEndpointRejected(KEYED), true, 'so the socket picker skips it too');
  assert.equal(notices.length, 1, 'and no second notice');
  console.log('ok  a known-bad endpoint is skipped, not re-asked');
}

{
  // Pasting a corrected key must give it a fresh chance immediately.
  clearRpcRejections();
  assert.equal(isEndpointRejected(KEYED), false);
  stubFetch(() => balance(9));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.data, 9);
  assert.deepEqual(hits, [KEYED], 'the keyed endpoint is tried again after the settings change');
  console.log('ok  a corrected key is retried at once');
}

{
  // With nowhere to fail over to, the message still has to be usable.
  clearRpcRejections();
  setRpcFallback(
    () => '',
    (l) => logs.push(l),
    (l) => notices.push(l),
  );
  stubFetch(() => unauthorized());
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.ok, false);
  assert.notEqual(r.message, 'RPC HTTP 401', 'never the raw status the user reported');
  assert.match(r.message, /Settings/);
  assert.ok(!r.message.includes(KEY));
  console.log('ok  with no fallback, the failure still explains itself');
}

{
  // A 500 keeps its old behaviour: retry the same endpoint, then fail over.
  clearRpcRejections();
  setRpcFallback(
    () => PUBLIC,
    (l) => logs.push(l),
    (l) => notices.push(l),
  );
  stubFetch((url) => (url === KEYED ? serverError() : balance(5)));
  const r = await getBalance(KEYED, OWNER);
  assert.equal(r.data, 5);
  assert.deepEqual(hits, [KEYED, KEYED, PUBLIC], 'a blip is still retried once before failing over');
  assert.equal(isEndpointRejected(KEYED), false, 'and a 500 does not condemn the endpoint');
  console.log('ok  transient failures behave exactly as before');
}

{
  // The socket path reads a status out of text ("Unexpected server response:
  // 401"), so it has to be fussy: only a keyed url, only a real code. A
  // false positive here would push a healthy public socket off the air.
  clearRpcRejections();
  const keyed = 'wss://mainnet.helius-rpc.com/?api-key=' + KEY;
  const pub = 'wss://api.mainnet-beta.solana.com';
  assert.equal(noteSocketRejection(keyed, 'Unexpected server response: 401'), true);
  assert.equal(isEndpointRejected(keyed), true);
  clearRpcRejections();
  assert.equal(noteSocketRejection(pub, 'Unexpected server response: 401'), false, 'a keyless socket has no key to reject');
  assert.equal(noteSocketRejection(keyed, 'closed with code 1401'), false, 'a digit run that merely contains 401 is not a 401');
  assert.equal(noteSocketRejection(keyed, 'socket closed'), false);
  assert.equal(isEndpointRejected(keyed), false, 'none of those condemned anything');
  console.log('ok  a socket handshake is only condemned on a real refusal of a real key');
}
