// What a token's X link points at. The app treated all of these as "has
// socials: yes", which is the boolean doing real work misleading someone.
import assert from 'node:assert';
import { countReuse, hasAccount, parseXLink } from './.xlink.mjs';

{
  const p = parseXLink('https://x.com/someproject');
  assert.equal(p.kind, 'profile');
  assert.equal(p.handle, 'someproject');
  assert.equal(hasAccount(p), true);
  // Profile sub-pages are still that account.
  assert.equal(parseXLink('https://twitter.com/someproject/with_replies').kind, 'profile');
  assert.equal(parseXLink('x.com/someproject').kind, 'profile', 'a missing scheme is normal in creator metadata');
  assert.equal(parseXLink('https://mobile.twitter.com/Some_Project').handle, 'Some_Project');
  console.log('ok  a profile link resolves to an account');
}

{
  // The important one: a link to someone else's viral post is not an account.
  const p = parseXLink('https://x.com/elonmusk/status/1234567890');
  assert.equal(p.kind, 'post');
  assert.equal(p.handle, 'elonmusk');
  assert.equal(p.postId, '1234567890');
  assert.equal(hasAccount(p), false, 'there is no account of THEIRS to judge');
  assert.match(p.label, /not their account/);
  console.log('ok  a post link is reported as a post, not an account');
}

{
  assert.equal(parseXLink('https://x.com/i/communities/1899').kind, 'community');
  assert.equal(parseXLink('https://x.com/search?q=dogwifhat').kind, 'search');
  assert.equal(parseXLink('https://x.com/hashtag/solana').kind, 'search');
  assert.equal(parseXLink('https://x.com/home').kind, 'other-x');
  assert.equal(parseXLink('https://x.com/').kind, 'other-x');
  for (const k of ['community', 'search', 'other-x']) {
    assert.equal(hasAccount({ kind: k, handle: null, postId: null, label: '' }), false);
  }
  console.log('ok  communities, searches and X routes are not accounts');
}

{
  // Hostname, never substring — this is the one that would matter.
  assert.equal(parseXLink('https://x.com.evil.tld/someproject').kind, 'not-x');
  assert.equal(parseXLink('https://notx.com/someproject').kind, 'not-x');
  assert.equal(parseXLink('https://t.me/someproject').kind, 'not-x');
  assert.equal(parseXLink('definitely not a url').kind, 'not-x');
  assert.equal(parseXLink('').kind, 'none');
  assert.equal(parseXLink(null).kind, 'none');
  assert.equal(parseXLink(undefined).kind, 'none');
  // A handle X could not issue is not a handle.
  assert.equal(parseXLink('https://x.com/way_too_long_a_handle_here').kind, 'other-x');
  assert.equal(parseXLink('https://x.com/bad-handle!').kind, 'other-x');
  console.log('ok  a lookalike host is never treated as X');
}

{
  // The free half of the feature: the same account or post across launches.
  const rows = [
    { mint: 'a', twitter: 'https://x.com/farm' },
    { mint: 'b', twitter: 'https://x.com/farm' },
    { mint: 'c', twitter: 'https://twitter.com/FARM' },
    { mint: 'd', twitter: 'https://x.com/elonmusk/status/999' },
    { mint: 'e', twitter: 'https://x.com/elonmusk/status/999' },
    { mint: 'f', twitter: null },
    { mint: 'g', twitter: 'https://t.me/other' },
  ];
  const farm = countReuse(parseXLink('https://x.com/farm'), rows, 'a');
  assert.equal(farm.handle, 2, 'case-insensitive, and excludes itself');
  const post = countReuse(parseXLink('https://x.com/elonmusk/status/999'), rows, 'd');
  assert.equal(post.post, 1, 'the same post on another launch');
  assert.equal(post.handle, 1, 'and the same handle behind it');
  const none = countReuse(parseXLink(null), rows, 'f');
  assert.deepEqual(none, { handle: 0, post: 0 }, 'no link, nothing to count');
  console.log('ok  reuse across launches is counted without a single request');
}
console.log('xlink: all tests passed');
