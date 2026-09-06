// A rejected RPC key must fail over, not fail.
//
// Reported 2026-09-05: a user saw "RPC HTTP 401" over and over. 401 was not
// classed as a transport failure, so it was neither retried nor failed over —
// every read died with that string and the app looked broken instead of
// mis-keyed. These are the rules that stop that happening again.
import assert from 'node:assert';
import { classifyRpcFailure, credentialsMessage, isRetryable, isUnauthorized, safeHost } from './.rpcerrors.mjs';

const KEY = 'aaaabbbb-cccc-dddd-eeee-ffff00001111';
const KEYED = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;

{
  assert.equal(classifyRpcFailure('RPC HTTP 401'), 'unauthorized');
  assert.equal(classifyRpcFailure('RPC HTTP 403'), 'unauthorized');
  assert.equal(classifyRpcFailure('RPC HTTP 429'), 'rate-limited');
  assert.equal(classifyRpcFailure('RPC HTTP 500'), 'transient');
  assert.equal(classifyRpcFailure('RPC HTTP 408'), 'transient');
  assert.equal(classifyRpcFailure('fetch failed'), 'transient');
  assert.equal(classifyRpcFailure('other side closed'), 'transient');
  // A JSON-RPC answer is an answer, not an outage.
  assert.equal(classifyRpcFailure('Invalid param: could not find account'), 'other');
  console.log('ok  every failure lands in the right bucket');
}

{
  assert.equal(isRetryable('RPC HTTP 401'), false, 'a wrong key is still wrong on the second try');
  assert.equal(isRetryable('RPC HTTP 403'), false);
  assert.equal(isRetryable('RPC HTTP 500'), true);
  assert.equal(isRetryable('RPC HTTP 429'), true);
  assert.equal(isUnauthorized('RPC HTTP 401'), true);
  assert.equal(isUnauthorized('RPC HTTP 500'), false);
  console.log('ok  bad credentials are never retried');
}

{
  const msg = credentialsMessage(safeHost(KEYED), '401');
  assert.ok(!msg.includes(KEY), 'the key must never reach a log line or a toast');
  assert.ok(msg.includes('mainnet.helius-rpc.com'), 'but the host is named, so the user knows which one');
  assert.match(msg, /Settings/, 'and the message names where the fix is');
  assert.ok(msg.length > 60, 'it is a sentence, not a status code');
  console.log('ok  the user is told what is wrong and where to fix it, without leaking the key');
}

{
  assert.equal(safeHost(KEYED), 'mainnet.helius-rpc.com');
  assert.equal(safeHost('not a url'), 'the RPC endpoint', 'an unparseable url still produces a printable name');
  console.log('ok  hosts are extracted safely');
}
