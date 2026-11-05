// The bottom-left cards: API key problems and errors, there until closed, and the
// feed getting out of a Helius plan with no credits (user report 2026-11-04).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { classifyHelius, maskSecrets } from '../test/.issues-shared.mjs';
import {
  raiseIssue,
  clearIssue,
  clearIssuesWithPrefix,
  closeIssue,
  closeAllIssues,
  listIssues,
  onIssuesChanged,
  resetIssues,
} from '../test/.appissues.mjs';

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
let n = 0;
const ok = (name, fn) => {
  resetIssues();
  fn();
  n += 1;
  console.log(`  ok  ${name}`);
};
const condition = (id = 'x', body = 'broken') => ({ id, level: 'error', title: 't', body });
const oneOff = (body = 'sell stuck') => ({ id: `notice:${body}`, level: 'error', title: '', body, condition: false });

// ── What Helius says ─────────────────────────────────────────────────────

const maxUsage = '{"jsonrpc":"2.0","error":{"code":-32429,"message":"max usage reached"}}';

ok('the reply that started this: ordinary requests fine, socket out of credits', () => {
  const v = classifyHelius({ status: 200, body: '{"result":1}' }, { status: 429, body: maxUsage });
  assert.equal(v.socketSpent, true);
  assert.equal(v.httpSpent, false);
  assert.equal(v.refused, null, 'the key itself was not refused');
  assert.equal(v.limited, null, 'and this is not a rate limit');
  assert.equal(v.fine, false);
});

ok('a plain rate limit is not out of credits', () => {
  const v = classifyHelius({ status: 200, body: '' }, { status: 429, body: 'too many connections' });
  assert.equal(v.socketSpent, false);
  assert.equal(v.limited, 'too many connections');
});

ok('a refused key is named, and a challenge page is not a refused key', () => {
  assert.equal(classifyHelius({ status: 401, body: '{"error":"invalid"}' }, null).refused, 401);
  assert.equal(classifyHelius(null, { status: 403, body: '{"error":"no"}' }).refused, 403);
  assert.equal(classifyHelius({ status: 403, body: '<!doctype html>' }, null).refused, null);
});

ok('no answer says nothing, either way', () => {
  const v = classifyHelius(null, null);
  assert.deepEqual([v.socketSpent, v.httpSpent, v.refused, v.limited, v.fine], [false, false, null, null, false]);
});

ok('only an open socket with working requests counts as fine', () => {
  assert.equal(classifyHelius({ status: 200, body: '' }, { status: 101, body: '' }).fine, true);
  assert.equal(classifyHelius({ status: 429, body: maxUsage }, { status: 101, body: '' }).fine, false);
  assert.equal(classifyHelius({ status: 200, body: '' }, null).fine, false);
});

// ── Secrets ──────────────────────────────────────────────────────────────

ok('a key in a URL never reaches a card', () => {
  const key = '11111111-2222-3333-4444-555555555555';
  raiseIssue(condition('x', `failed: wss://mainnet.helius-rpc.com/?api-key=${key} and https://a.g.alchemy.com/v2/abcdefghijklmnopqrstuvwx`));
  const shown = JSON.stringify(listIssues());
  assert.ok(!shown.includes(key));
  assert.ok(!shown.includes('abcdefghijklmnopqrstuvwx'));
  assert.ok(shown.includes('api-key=***'));
  assert.equal(maskSecrets('https://x.io/?a=1&token=secret&b=2'), 'https://x.io/?a=1&token=***&b=2');
});

// ── Staying until closed ─────────────────────────────────────────────────

ok('a card stays when its problem clears, and says so', () => {
  raiseIssue(condition());
  clearIssue('x');
  const [i] = listIssues();
  assert.ok(i, 'still listed');
  assert.ok(i.clearedAt > 0);
  closeIssue('x');
  assert.equal(listIssues().length, 0);
});

ok('closing a problem that still holds keeps it closed through its retries', () => {
  raiseIssue(condition());
  closeIssue('x');
  // A socket retrying every 30 s must not undo the X.
  raiseIssue(condition());
  raiseIssue(condition('x', 'new wording'));
  assert.equal(listIssues().length, 0);
});

ok('it comes back once it has cleared and happened again', () => {
  raiseIssue(condition());
  closeIssue('x');
  clearIssue('x');
  raiseIssue(condition());
  assert.equal(listIssues().length, 1);
});

ok('a problem that returns reopens its card', () => {
  raiseIssue(condition());
  clearIssue('x');
  raiseIssue(condition());
  assert.equal(listIssues()[0].clearedAt, null);
});

ok('a one-off comes back every time it happens', () => {
  raiseIssue(oneOff());
  raiseIssue(oneOff());
  assert.equal(listIssues()[0].count, 2);
  closeIssue('notice:sell stuck');
  raiseIssue(oneOff());
  assert.equal(listIssues().length, 1, 'a second stuck sell is a new problem');
});

ok('reported every second, a condition redraws nothing', () => {
  let pushes = 0;
  onIssuesChanged(() => {
    pushes += 1;
  });
  raiseIssue(condition());
  raiseIssue(condition());
  raiseIssue(condition());
  assert.equal(pushes, 1);
  raiseIssue(condition('x', 'different'));
  assert.equal(pushes, 2);
  onIssuesChanged(() => undefined);
});

ok('an error storm is capped, cleared ones going first', () => {
  raiseIssue(condition('cleared'));
  clearIssue('cleared');
  raiseIssue(condition('active'));
  for (let i = 0; i < 40; i += 1) raiseIssue(oneOff(`e${i}`));
  const ids = listIssues().map((i) => i.id);
  assert.equal(ids.length, 30);
  assert.ok(!ids.includes('cleared'));
});

ok('a corrected key clears every card about the old one', () => {
  raiseIssue(condition('rpc-key:a'));
  raiseIssue(condition('rpc-key:b'));
  closeIssue('rpc-key:b');
  clearIssuesWithPrefix('rpc-key:');
  assert.ok(listIssues()[0].clearedAt > 0);
  raiseIssue(condition('rpc-key:b'));
  assert.equal(listIssues().filter((i) => i.id === 'rpc-key:b').length, 1, 'a new refusal is not muted');
});

ok('close all closes everything and still holds what is active', () => {
  raiseIssue(condition('a'));
  raiseIssue(oneOff());
  closeAllIssues();
  assert.equal(listIssues().length, 0);
  raiseIssue(condition('a'));
  assert.equal(listIssues().length, 0);
});

// ── Wiring ───────────────────────────────────────────────────────────────

const ipc = read('electron/ipc.ts');
const engine = read('electron/engine/engine.ts');
const stack = read('src/components/IssueStack.tsx');
const health = read('electron/system/heliusHealth.ts');

ok('a key saved while the scanner runs reaches the running feed', () => {
  assert.ok(ipc.includes("getEngine().syncFeeds('Solana RPC settings changed');"));
  assert.match(engine, /syncFeeds\(why: string\): void \{\s*\n\s*if \(!this\.running \|\| this\.feedSignature\(\) === this\.openedFeedSignature\) return;/);
  // Start and restart build the sockets the same way.
  assert.equal(engine.match(/new FeedManager\(/g).length, 2);
  assert.match(engine, /this\.openFeeds\(feedUrls\);/);
});

ok('with no credits the feed goes public at once, and the token tape follows', () => {
  assert.match(health, /if \(v\.socketSpent && host\?\.leaveHeliusFeed\(\)\) switchedOff = true;/);
  assert.match(engine, /this\.disableHeliusFeed\?\.\(\);\s*\n\s*const moved = this\.feedSignature\(\) !== before;\s*\n\s*if \(moved\) this\.syncFeeds\(why\);/);
  assert.match(engine, /isEndpointRejected\(keyed\) \|\| isSocketSpent\(keyed\) \? rpc\.wssUrl : keyed/);
});

ok('the spent budget cut-off now takes effect without a restart too', () => {
  assert.match(engine, /this\.leaveHeliusFeed\('Helius credit budget spent'\);/);
});

ok('the check only asks, and prints nothing a key could be in', () => {
  assert.doesNotMatch(health, /logger|console\./);
  assert.doesNotMatch(health, /message: `|\$\{(httpUrl|wssUrl|key)\}[^`]*body/);
});

ok('a dropped connection or a stale answer changes nothing', () => {
  assert.match(health, /if \(\(host\?\.key\(\) \?\? ''\)\.trim\(\) !== key\) \{\s*\n\s*again = true;/);
  assert.match(health, /\} else if \(v\.fine\) \{/);
});

ok('errors become cards instead of flashing top right', () => {
  assert.match(ipc, /ev\.kind === 'toast' && ev\.level === 'error'/);
  assert.doesNotMatch(read('src/state/AppStateProvider.tsx'), /ev\.level === 'error' && !isPanelWindow\(\)/);
});

ok('the cards sit under the wallet panel and the confirm dialogs', () => {
  const z = Number(/z-\[(\d+)\]/.exec(stack)[1]);
  assert.ok(z < Number(/fixed inset-0 z-\[(\d+)\]/.exec(read('src/components/terminal/WalletPanel.tsx'))[1]));
  assert.ok(z < Number(/fixed inset-0 z-\[(\d+)\]/.exec(read('src/state/ModalProvider.tsx'))[1]));
  assert.ok(z > 50);
});

ok('every card has an X, and only closing removes one', () => {
  assert.match(stack, /aria-label="Close"/);
  assert.doesNotMatch(stack, /setTimeout|setInterval/);
  assert.doesNotMatch(read('electron/system/appIssues.ts'), /setTimeout|setInterval/);
});

ok('a built-in EVM endpoint does not send the user looking for a key', () => {
  const evm = read('electron/evm/client.ts');
  assert.match(evm, /if \(isChainOwnUrl\(chain, url\)\) \{\s*\n\s*logger\.warn\([^\n]*not your key/);
});

ok('a provider used without a key raises nothing', () => {
  const http = read('electron/data/http.ts');
  assert.match(http, /if \(!usesApiKey\(headers\)\) return;/);
});

console.log(`issues: ${n} passed`);
