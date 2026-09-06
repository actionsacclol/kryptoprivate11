// Social-metadata extraction tests — the parser is the risky part (the fetch
// is plain I/O). Verifies channel detection, url validation, nesting, and that
// malformed input degrades to a clean "unresolved-shaped" result.

import assert from 'node:assert/strict';
import { extractSocialsForTest as extract, candidateUrlsForTest as urls } from './.metadata.mjs';

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

const ALLOWED = ['ipfs.io', 'cloudflare-ipfs.com'];
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

console.log('metadata: all tests passed');
