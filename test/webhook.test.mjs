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
import { MAX_WEBHOOK_CHARS, publicTokenUrl, redactWebhook, webhookUrlProblem } from './.webhook.mjs';

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

console.log('webhook: all tests passed');
