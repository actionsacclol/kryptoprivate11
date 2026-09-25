// Social-metadata extraction tests — the parser is the risky part (the fetch
// is plain I/O). Verifies channel detection, url validation, nesting, and that
// malformed input degrades to a clean "unresolved-shaped" result.

import assert from 'node:assert/strict';
import {
  extractSocialsForTest as extract,
  candidateUrlsForTest as urls,
  extractLinksForTest as links,
  fetchSocials,
  fetchMetadataLinks,
  metadataLinksIfCached,
  clearCache,
  setClockForTest,
  parkedGatewaysForTest,
} from './.metadata.mjs';

// Full pump-style metadata with all three socials at top level.
{
  const s = extract({
    name: 'Test', symbol: 'TST', description: 'a real memecoin',
    image: 'https://ipfs.io/ipfs/abc/img.png',
    twitter: 'https://x.com/testcoin',
    telegram: 'https://t.me/testcoin',
    website: 'https://testcoin.fun',
  });
  assert.equal(s.resolved, true);
  assert.equal(s.twitter, true);
  assert.equal(s.telegram, true);
  assert.equal(s.website, true);
  assert.equal(s.hasImage, true);
  assert.equal(s.hasDescription, true);
  assert.equal(s.socialCount, 3);
  console.log('ok  full socials at top level');
}

// Socials nested under `extensions` (the other pump layout).
{
  const s = extract({
    image: 'https://x/i.png',
    extensions: { twitter: 'https://twitter.com/foo', website: 'https://foo.xyz' },
  });
  assert.equal(s.twitter, true);
  assert.equal(s.website, true);
  assert.equal(s.telegram, false);
  assert.equal(s.socialCount, 2);
  console.log('ok  socials nested in extensions');
}

// `x` alias counts as twitter.
{
  const s = extract({ x: 'https://x.com/bar' });
  assert.equal(s.twitter, true);
  assert.equal(s.socialCount, 1);
  console.log('ok  x alias → twitter');
}

// Non-url junk in social fields does NOT count (spam guard).
{
  const s = extract({ twitter: 'not a url', telegram: '', website: 'testcoin' });
  assert.equal(s.twitter, false);
  assert.equal(s.telegram, false);
  assert.equal(s.website, false);
  assert.equal(s.socialCount, 0);
  console.log('ok  non-url social fields rejected');
}

// Bare metadata (image only, no socials) — the common low-effort launch.
{
  const s = extract({ name: 'x', symbol: 'x', image: 'https://a/b.png' });
  assert.equal(s.resolved, true);
  assert.equal(s.socialCount, 0);
  assert.equal(s.hasImage, true);
  assert.equal(s.hasDescription, false);
  console.log('ok  image-only launch → 0 socials, resolved');
}

// Empty object resolves but has nothing.
{
  const s = extract({});
  assert.equal(s.resolved, true);
  assert.equal(s.socialCount, 0);
  assert.equal(s.hasImage, false);
  console.log('ok  empty metadata');
}

// ── Fetch allowlist (security) ───────────────────────────────────────────
// The `uri` is chosen by the token's creator. Before 2026-08-16 an arbitrary
// http(s) URL was fetched verbatim, leaking the IP + timestamp of every live
// install to any launcher. These pin the allowlist shut.

// The gateway list, as the privacy policy names it (test/legal.test.mjs pins
// the policy against the same three hosts). cloudflare-ipfs.com stopped
// resolving and was replaced 2026-09-20.
const ALLOWED = ['ipfs.io', 'ipfs.4everland.io', 'ipfs.filebase.io'];
const CID = 'QmS4ustL54uo8FzR9455qaxZwuMiUhyvMcX9Ba8nUH4uVv';
const hostOf = (u) => new URL(u).hostname;

// ipfs:// resolves onto allowlisted gateways only.
{
  const out = urls(`ipfs://${CID}`);
  assert.ok(out.length > 0);
  for (const u of out) assert.ok(ALLOWED.includes(hostOf(u)), `leaked host: ${u}`);
  console.log('ok  ipfs:// → allowlisted gateways only');
}

// A creator-controlled host is NOT fetched — this is the deanonymization bug.
{
  assert.deepEqual(urls('https://evil.example.com/track/abc.json'), []);
  assert.deepEqual(urls('http://evil.example.com/a.json'), []);
  console.log('ok  arbitrary creator host rejected');
}

// SSRF targets are unreachable.
{
  for (const u of [
    'http://127.0.0.1:8899/',
    'http://localhost/admin',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://192.168.1.1/',
  ]) {
    assert.deepEqual(urls(u), [], `SSRF target reachable: ${u}`);
  }
  console.log('ok  loopback / link-local / LAN targets rejected');
}

// A non-allowlisted gateway still serves via a trusted one, never itself.
{
  const out = urls(`https://evil-gateway.example.com/ipfs/${CID}`);
  assert.ok(out.length > 0);
  for (const u of out) assert.ok(ALLOWED.includes(hostOf(u)), `leaked host: ${u}`);
  console.log('ok  untrusted gateway path re-pointed at a trusted gateway');
}

// An allowlisted host over plain http is a downgrade and is not fetched as-is.
{
  const out = urls(`http://ipfs.io/ipfs/${CID}`);
  for (const u of out) assert.equal(new URL(u).protocol, 'https:');
  console.log('ok  http downgrade on an allowlisted host rejected');
}

// Junk CIDs and non-http schemes produce nothing.
{
  assert.deepEqual(urls('ipfs://../../etc/passwd'), []);
  assert.deepEqual(urls('file:///C:/Windows/win.ini'), []);
  assert.deepEqual(urls('data:application/json,{}'), []);
  assert.deepEqual(urls(''), []);
  console.log('ok  malformed cid / non-http scheme rejected');
}

// ── Links (2026-09-20): the URLs themselves, as the creator wrote them ───
// The Links panel and the token page show these; until this day only the
// yes/no fingerprint above left this module, so a coin whose X and website
// pump.fun had not copied yet (every coin for its first minutes) had none.

{
  const l = links({
    name: 'Source', symbol: 'SOURCE',
    image: 'https://ipfs.io/ipfs/bafkreicyl6eewcnjazi4zbis2nvicw7n7bnhkazbosd2a26zfgmoxz3kry',
    twitter: 'https://x.com/jackzampolin',
    website: 'https://source.network/',
    extensions: { telegram: 'https://t.me/source' },
  });
  assert.deepEqual(l, {
    twitter: 'https://x.com/jackzampolin',
    telegram: 'https://t.me/source',
    website: 'https://source.network/',
    image: 'https://ipfs.io/ipfs/bafkreicyl6eewcnjazi4zbis2nvicw7n7bnhkazbosd2a26zfgmoxz3kry',
    kryptoBot: null,
  });
  console.log('ok  links read off the file, top level and extensions');
}

// $Krypto Mode (2026-09-25): a declared creator bot is read off the
// description, so the token page can label the coin.
{
  const bot = 'KryptoBot1111111111111111111111111111111111';
  const d = `gm\nKrypto Mode: this coin has a public trading bot, wallet ${bot}. It buys and sells this coin.\nLaunched with krypt.cc/bot`;
  assert.equal(links({ description: d }).kryptoBot, bot);
  assert.equal(links({ description: 'Krypto Mode: wallet not-an-address' }).kryptoBot, null);
  assert.equal(links({ description: 42 }).kryptoBot, null);
  console.log('ok  a declared Krypto Mode bot is read off the description');
}

// Nothing is guessed: a handle is not a link, `x` stands in for twitter, an
// absurd length is dropped.
{
  const l = links({ x: 'https://x.com/bar', twitter: 'not a url', website: '@handle', telegram: 't.me/foo' });
  assert.equal(l.twitter, 'https://x.com/bar');
  assert.equal(l.website, null);
  assert.equal(l.telegram, null);
  assert.equal(l.image, null);
  assert.equal(links({ website: 'https://a.example/' + 'x'.repeat(3_000) }).website, null);
  console.log('ok  handles and junk are not links; x alias; overlong dropped');
}

// ── Fetch behaviour, against a stubbed fetch ────────────────────────────
const DOC = { twitter: 'https://x.com/source', website: 'https://source.network/', image: 'https://ipfs.io/ipfs/bafkreicyl6ee' };
const calls = [];
/** host → status; a host not listed serves DOC. */
let status = {};
let clock = 1_000_000;
setClockForTest(() => clock);
globalThis.fetch = async (url) => {
  const host = new URL(url).hostname;
  calls.push(host);
  const st = status[host] ?? 200;
  if (st !== 200) return new Response('no', { status: st });
  return new Response(JSON.stringify(DOC), { status: 200, headers: { 'content-type': 'application/json' } });
};
const cidA = 'bafkreifperm6h64s2pan3jgsq2p6xbxlqf2tnwbd65bs44vzabsoqmp254';
const cidB = 'bafkreicyl6eewcnjazi4zbis2nvicw7n7bnhkazbosd2a26zfgmoxz3kry';

// A gateway that says 429 is parked and the next one serves; a second
// lookup skips the parked one without asking it again.
{
  clearCache();
  calls.length = 0;
  status = { 'ipfs.io': 429 };
  const l = await fetchMetadataLinks(`https://ipfs.io/ipfs/${cidA}`);
  assert.equal(l?.twitter, 'https://x.com/source');
  assert.deepEqual(calls, ['ipfs.io', 'ipfs.4everland.io']);
  assert.deepEqual(parkedGatewaysForTest(), ['ipfs.io']);
  calls.length = 0;
  const l2 = await fetchMetadataLinks(`ipfs://${cidB}`);
  assert.equal(l2?.website, 'https://source.network/');
  assert.deepEqual(calls, ['ipfs.4everland.io'], 'the parked gateway is not asked while parked');
  console.log('ok  a 429 parks the gateway; the next one serves; parked is skipped');
}

// Every gateway down: not known now, remembered as a miss for a minute, and
// asked again after — a coin seconds old is often not on a gateway yet, and
// the old permanent miss is why a runner flag could never show its X.
{
  clearCache();
  calls.length = 0;
  status = { 'ipfs.io': 503, 'ipfs.4everland.io': 429, 'ipfs.filebase.io': 502 };
  const uri = `https://ipfs.io/ipfs/${cidA}`;
  assert.equal(await fetchMetadataLinks(uri), null);
  assert.equal(calls.length, 3);
  assert.equal(await fetchMetadataLinks(uri), null);
  assert.equal(calls.length, 3, 'a miss inside the window makes no request');
  status = {};
  clock += 61_000; // past the miss window AND the gateway parks
  const l = await fetchMetadataLinks(uri);
  assert.equal(l?.twitter, 'https://x.com/source');
  assert.equal(calls.length, 4, 'asked once more after the window');
  console.log('ok  a miss is retried after a minute, not remembered forever');
}

// The create path and a person's lookup seconds later share one fetch, and
// the batch paths read the result without a request.
{
  clearCache();
  calls.length = 0;
  status = {};
  const uri = `https://ipfs.io/ipfs/${cidB}`;
  const [fp, l] = await Promise.all([fetchSocials(uri), fetchMetadataLinks(uri)]);
  assert.equal(fp.twitter, true);
  assert.equal(fp.socialCount, 2);
  assert.equal(l?.twitter, 'https://x.com/source');
  assert.equal(calls.length, 1, 'one request for both callers');
  assert.equal(metadataLinksIfCached(uri)?.website, 'https://source.network/');
  console.log('ok  fingerprint + links from one fetch; cached read is free');
}

// A URI nothing may be fetched from makes no request at all, either way.
{
  clearCache();
  calls.length = 0;
  const fp = await fetchSocials('https://evil.example.com/track.json');
  assert.equal(fp.resolved, false);
  assert.equal(await fetchMetadataLinks('https://evil.example.com/track.json'), null);
  assert.equal(metadataLinksIfCached('https://evil.example.com/track.json'), null);
  assert.equal(calls.length, 0);
  console.log('ok  an unfetchable uri is never requested');
}

setClockForTest(null);
console.log('metadata: all tests passed');
