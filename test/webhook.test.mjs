// Discord webhook rules — the pure half (shared/webhook.ts).
//
// The URL is a CREDENTIAL: its last path segment is the webhook token, and
// anyone holding it can post into that channel as you. So two properties
// matter more than the rest, and both are pinned here:
//
//   1. Only Discord's hosts are ever accepted. This is the one field in the
//      app that takes a URL from the renderer; without the allowlist it is a
//      settings field that POSTs your flagged tokens anywhere.
//   2. The token never survives redaction. Logs, toasts and the UI all render
//      the redacted form, so a screenshot or a pasted log cannot leak it.

import assert from 'node:assert/strict';
import { MAX_WEBHOOK_CHARS, calloutEmbed, publicTokenUrl, redactWebhook, scriptEmbed, webhookUrlProblem } from './.webhook.mjs';

const ID = '123456789012345678';
const TOKEN = 'S3cr3t-tok3n_ThatMustNeverLeak';
const GOOD = `https://discord.com/api/webhooks/${ID}/${TOKEN}`;

{
  assert.equal(webhookUrlProblem(GOOD), null);
  assert.equal(webhookUrlProblem(`https://discord.com/api/v10/webhooks/${ID}/${TOKEN}`), null);
  assert.equal(webhookUrlProblem(`https://discordapp.com/api/webhooks/${ID}/${TOKEN}`), null);
  assert.equal(webhookUrlProblem(`https://ptb.discord.com/api/webhooks/${ID}/${TOKEN}`), null);
  console.log('ok  Discord webhook URLs are accepted, versioned or not');
}

{
  // Empty is OFF, and a default must pass its own rule or every panel that
  // spreads the stored block becomes unsaveable (the 2026-09-08 trap).
  assert.equal(webhookUrlProblem(''), null);
  assert.equal(webhookUrlProblem('   '), null);
  console.log('ok  empty is OFF, not an error');
}

{
  // The allowlist. `discord.com.evil.test` is the one that matters: a prefix
  // match instead of an exact host would accept it.
  for (const url of [
    `https://discord.com.evil.test/api/webhooks/${ID}/${TOKEN}`,
    `https://evildiscord.com/api/webhooks/${ID}/${TOKEN}`,
    `https://hooks.slack.com/services/T/B/${TOKEN}`,
    `https://127.0.0.1/api/webhooks/${ID}/${TOKEN}`,
    `https://[::1]/api/webhooks/${ID}/${TOKEN}`,
    `http://discord.com/api/webhooks/${ID}/${TOKEN}`,
    `ftp://discord.com/api/webhooks/${ID}/${TOKEN}`,
  ]) {
    assert.ok(webhookUrlProblem(url), `${url} MUST be refused`);
  }
  console.log('ok  every non-Discord host, and plain http, is refused');
}

{
  for (const url of [
    'https://discord.com/channels/1/2',
    'https://discord.com/api/users/@me',
    `https://discord.com/api/webhooks/${ID}`,
    'https://discord.com/',
    'gibberish',
  ]) {
    assert.ok(webhookUrlProblem(url), `${url} MUST be refused`);
  }
  console.log('ok  a Discord URL that is not a webhook is refused');
}

{
  assert.ok(webhookUrlProblem(`https://discord.com/api/webhooks/${ID}/${'x'.repeat(MAX_WEBHOOK_CHARS)}`));
  console.log('ok  an absurdly long URL is refused');
}

{
  // THE property: the token must not survive, in any form.
  const shown = redactWebhook(GOOD);
  assert.ok(!shown.includes(TOKEN), 'the webhook token leaked into the redacted form');
  assert.ok(!shown.includes(TOKEN.slice(0, 8)), 'a prefix of the token leaked');
  assert.ok(shown.includes('discord.com'), 'the host is still recognisable');
  assert.equal(redactWebhook(''), '(none)');
  assert.equal(redactWebhook('not a url'), '(malformed)');
  console.log('ok  redaction keeps the host and never the token');
}

{
  assert.equal(publicTokenUrl('solana', 'Mint111'), 'https://pump.fun/coin/Mint111');
  assert.match(publicTokenUrl('bnb', '0xabc'), /^https:\/\/bscscan\.com\/token\/0xabc$/);
  assert.match(publicTokenUrl('robinhood', '0xabc'), /^https:\/\/.*\/token\/0xabc$/);
  assert.equal(publicTokenUrl('solana', ''), null);
  console.log('ok  the posted link points at a public page per chain');
}

// A script's embed (bot.discord, 2026-09-23). The script supplies the embed
// only; everything in it is rebuilt to Discord's limits here.
{
  const r = scriptEmbed(
    {
      title: 'x'.repeat(400),
      description: 'called',
      url: 'javascript:alert(1)',
      color: 0x22c55e,
      fields: [{ name: 'MC', value: '$9k', inline: true }, { name: '', value: 'dropped' }, ...Array(20).fill({ name: 'n', value: 'v' })],
      thumbnail: { url: 'http://insecure.example/i.png' },
      footer: { text: 'mine' },
      content: '@everyone',
      webhookUrl: 'https://evil.example/',
    },
    'scorenow',
    false,
  );
  assert.ok('embed' in r);
  const e = r.embed;
  assert.equal(e.title.length, 256, 'title capped to Discord’s limit');
  assert.equal(e.url, undefined, 'only https links survive');
  assert.equal(e.thumbnail, undefined, 'an http image is dropped');
  assert.equal(e.fields.length, 10, 'at most ten fields, and an empty one is dropped');
  assert.equal(e.fields[0].inline, true);
  assert.equal(e.color, 0x22c55e);
  assert.match(e.footer.text, /^mine · Krypto Bot script: scorenow$/, 'the footer always names the script');
  assert.deepEqual(Object.keys(e).sort(), ['color', 'description', 'fields', 'footer', 'timestamp', 'title'], 'unknown keys never pass through');
  const p = scriptEmbed({ description: 'd', footer: { nope: 1 } }, 's', true);
  assert.equal(p.embed.footer.text, 'PAPER · Krypto Bot script: s', 'a paper run says so, and an object footer is never [object Object]');
  assert.ok('error' in scriptEmbed({}, 's', false), 'an empty embed is refused rather than posted blank');
  assert.equal(scriptEmbed({ title: 't', url: 'https://pump.fun/callouts/a/b' }, 's', false).embed.url, 'https://pump.fun/callouts/a/b');
  console.log('ok  a script embed is rebuilt field by field to Discord’s limits');
}

{
  const a = scriptEmbed({ title: 't', author: { name: 'Krypto Bot', url: 'https://krypt.cc/bot', icon_url: 'http://x/i.png' } }, 's', false).embed.author;
  assert.deepEqual(a, { name: 'Krypto Bot', url: 'https://krypt.cc/bot' }, 'the author line links, and an http icon is dropped');
  assert.equal(scriptEmbed({ title: 't', author: {} }, 's', false).embed.author, undefined, 'no name, no author line');
  console.log('ok  an embed may carry a linked author line');
}

{
  const MINT = '25vdvxAatzG4WeeRAZjGZTDHGdMzKUnqkqQT4cXrpump';
  const link = `https://pump.fun/callouts/${MINT}/c58c3d62-1111-4222-8333-444455556666`;
  const e = calloutEmbed({ mint: MINT, name: 'BotFamily', symbol: 'BOTFMLY', thesis: 'early', link, mcUsd: 8096, holders: 144, buyers: 53, curvePct: 49.2, imageUrl: 'https://cdn.example/i.jpg' });
  assert.equal(e.title, '📣 BotFamily ($BOTFMLY)');
  assert.equal(e.url, link, 'the title opens the callout');
  assert.deepEqual(e.author, { name: 'Krypto Bot · new call', url: 'https://krypt.cc/bot' });
  assert.match(e.description, /\*Not financial advice\.\*/);
  assert.deepEqual(e.fields.map((f) => [f.name, f.value]).slice(0, 4), [['Market cap', '$8.1k'], ['Holders', '144'], ['Buyers', '53'], ['Curve', '49%']]);
  assert.match(e.fields[4].value, /^\[Callout\]\(.*\) · \[DexScreener\]\(.*\) · \[Krypto Bot\]\(https:\/\/krypt\.cc\/bot\)$/, 'no bare pump.fun link, no contract, no odds');
  assert.equal(e.footer.text, 'krypt.cc/bot · Krypto Bot auto-callout');
  const u = calloutEmbed({ mint: MINT, name: null, symbol: null, thesis: 'x', link: null, mcUsd: null, holders: null, buyers: null, curvePct: null, imageUrl: null, test: true });
  assert.ok(u.title.startsWith('🧪 TEST'), 'a test says so');
  assert.deepEqual(u.fields.slice(0, 4).map((f) => f.value), ['—', '—', '—', '—'], 'unknown is an em dash, never 0');
  assert.equal(u.url, `https://pump.fun/coin/${MINT}`, 'no callout id → the coin page');
  console.log('ok  the callout embed matches the script’s layout, honest about unknowns');
}

console.log('webhook: all tests passed');
