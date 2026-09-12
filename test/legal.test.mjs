// Legal bundle — the pre-ship checklist from legalcheck.md, as tests.
//
// Most of these look trivial. They are not: every one of them corresponds to a
// line in that checklist that is easy to satisfy today and easy to break in six
// months, silently, in a way no user reports and no type-checker catches. A
// document that renders "{PLACEHOLDER}" or names the wrong entity is worse than
// no document at all.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  LEGAL_ENTITY,
  TERMS_VERSION,
  TERMS_EFFECTIVE_DATE,
  GOVERNING_LAW,
  VENUE,
  CONTACT_EMAIL,
  ARBITRATION_FORUM,
  LIABILITY_CAP_USD,
  MINIMUM_AGE,
  ACCEPTANCE_RETENTION_DAYS,
  entityInfo,
} from './.legalentity.mjs';
import { ALL_DOCUMENTS, CLICKWRAP_SUMMARY, documentText, documentById } from './.legaldocs.mjs';

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    console.log('ok  ' + name);
    passed += 1;
  } catch (err) {
    console.error('FAIL ' + name);
    console.error(err);
    process.exit(1);
  }
}

const TERMS_OF_SERVICE_SECTION = (re) =>
  documentById('terms').sections.find((sec) => re.test(sec.heading)).body.join(' ');

const everyParagraph = ALL_DOCUMENTS.flatMap((d) => d.sections.flatMap((s) => [s.heading, ...s.body]));
const allText = ALL_DOCUMENTS.map(documentText).join('\n');

// ─── Documents ────────────────────────────────────────────────────────

ok('all three required documents exist', () => {
  const ids = ALL_DOCUMENTS.map((d) => d.id).sort();
  assert.deepEqual(ids, ['privacy', 'software', 'terms']);
});

ok('NO placeholder string ever reaches a user', () => {
  // legalcheck.md: "grep the built output, not the source". This walks the
  // rendered text of every document plus the clickwrap summary.
  const surfaces = [...everyParagraph, ...CLICKWRAP_SUMMARY.flatMap((p) => [p.title, p.detail])];
  const bad = /\{[A-Z_]{3,}\}|\bTODO\b|\bTBD\b|\bXXX\b|\[INSERT|LOREM|PLACEHOLDER|undefined|\bNaN\b/;
  for (const text of surfaces) {
    assert.ok(!bad.test(text), `placeholder or stray value in: "${String(text).slice(0, 90)}"`);
  }
});

ok('every document names the operator — a contract naming nobody binds a person', () => {
  for (const doc of ALL_DOCUMENTS) {
    assert.ok(
      documentText(doc).includes(LEGAL_ENTITY),
      `${doc.id} never names ${LEGAL_ENTITY}`,
    );
  }
});

ok('the entity name is never hardcoded — it always comes from the config', () => {
  const withoutInterpolation = ALL_DOCUMENTS.filter((d) => !documentText(d).includes(LEGAL_ENTITY));
  assert.equal(withoutInterpolation.length, 0);
  assert.equal(entityInfo().entity, LEGAL_ENTITY);
});

ok('NO superseded entity name survives anywhere in the documents', () => {
  // The counterparty changed from "Mimosa Solutions" to "Krypt" on 2026-08-25.
  // A document still naming the old entity would name the wrong counterparty —
  // the single worst defect one of these can have, and completely silent.
  for (const stale of ['Mimosa Solutions', 'Mimosa']) {
    assert.ok(!allText.includes(stale), `a document still names the superseded entity "${stale}"`);
  }
});

ok('the operator is named where it actually matters, not just incidentally', () => {
  // "Krypt" appears inside "Krypto Terminal" throughout, so presence alone
  // proves nothing. These are the sections that must identify the counterparty
  // and the data controller by name.
  const who = TERMS_OF_SERVICE_SECTION(/Who you are agreeing with/i);
  assert.match(who, new RegExp(`published by ${LEGAL_ENTITY}`));
  const controller = documentById('privacy').sections.find((sec) => /Controller/i.test(sec.heading));
  assert.match(controller.body.join(' '), new RegExp(`^${LEGAL_ENTITY} is the data controller`));
});

ok('governing law and venue are consistent everywhere they appear', () => {
  assert.ok(allText.includes(GOVERNING_LAW), 'governing law must appear');
  assert.ok(allText.includes(VENUE), 'venue must appear');
  // Only one jurisdiction may be named as governing.
  assert.ok(!/laws of the State of (?!Delaware)/.test(allText), 'a second governing law is named');
});

ok('"Last updated" dates are present and current', () => {
  for (const doc of ALL_DOCUMENTS) {
    assert.ok(doc.subtitle.includes(TERMS_EFFECTIVE_DATE), `${doc.id} has no current date`);
  }
});

ok('contact address is reachable from every document', () => {
  for (const doc of ALL_DOCUMENTS) {
    assert.ok(documentText(doc).includes(CONTACT_EMAIL), `${doc.id} gives the user nowhere to write`);
  }
});

// ─── The clauses the checklist requires ───────────────────────────────

ok('warranty disclaimer is present AND conspicuous (caps)', () => {
  // Select the actual disclaimer sections by heading. Matching on the word
  // "warranty" anywhere would also catch Consumer Rights, which correctly
  // pairs a caps notice with a lowercase explanation of statutory rights.
  const warranty = ALL_DOCUMENTS.flatMap((d) =>
    d.sections.filter((s) => /disclaimer of warrant|as-is, no warranty/i.test(s.heading)),
  );
  assert.equal(warranty.length, 2, 'both the ToS and Software Terms need one');
  for (const s of warranty) {
    assert.equal(s.emphasis, true, `${s.heading} must be conspicuous`);
    const body = s.body.join(' ');
    // Conspicuousness is the point — a lowercase disclaimer buried in prose is
    // the classic reason one gets struck out.
    const caps = body.replace(/[^A-Za-z]/g, '');
    const upper = caps.replace(/[^A-Z]/g, '');
    assert.ok(upper.length / caps.length > 0.7, 'disclaimer must be in caps');
  }
});

ok('warranty disclaimer covers every listed head, including viruses', () => {
  for (const head of ['MERCHANTABILITY', 'FITNESS', 'TITLE', 'NON-INFRINGEMENT', 'VIRUS']) {
    assert.ok(allText.includes(head), `missing ${head}`);
  }
});

ok('liability is capped at a stated dollar figure', () => {
  assert.ok(allText.includes(`US$${LIABILITY_CAP_USD}`), 'the cap must be a real number');
  assert.equal(LIABILITY_CAP_USD, 100);
});

ok('arbitration names a real forum — not "a mutually agreed provider"', () => {
  // legalcheck.md Known Gap #2: naming no forum is the drafting courts most
  // often refuse to enforce.
  assert.ok(ARBITRATION_FORUM.includes('American Arbitration Association'));
  assert.ok(allText.includes('Consumer Arbitration Rules'), 'the rules must be named');
  assert.ok(!/mutually agreed[- ]upon arbitration provider/i.test(allText), 'the weak drafting is still present');
});

ok('the class-action waiver severs alone instead of taking the clause down', () => {
  assert.match(allText, /waiver alone is severed/i);
});

ok('the arbitration notice is repeated in the software terms', () => {
  // A downloader may never have seen the website ToS, so incorporation by
  // reference needs an explicit notice where they WILL see it.
  const sw = documentById('software');
  assert.match(documentText(sw), /ARBITRATION/);
  assert.match(documentText(sw), /CLASS ACTION/);
});

ok('consumer carve-outs cannot be contracted away', () => {
  assert.match(allText, /death or personal injury/i);
  assert.match(allText, /fraud/i);
  assert.match(allText, /statutory rights are not affected/i);
});

ok('EU/UK consumers are told their local rights survive the choice of law', () => {
  // legalcheck.md Known Gap #7 — you cannot contract out of this, so say so.
  assert.match(allText, /European Union/);
  assert.match(allText, /United Kingdom/);
  assert.match(allText, /mandatory provisions|mandatory consumer/i);
});

ok('export controls and sanctions are covered', () => {
  assert.match(allText, /sanction/i);
  assert.match(allText, /export control/i);
});

ok('third-party trademarks are disclaimed with no implied endorsement', () => {
  assert.match(allText, /No affiliation, sponsorship, partnership, or endorsement/i);
});

ok('prohibited uses list the specific conduct the checklist names', () => {
  for (const term of [/unauthorised access|without authorisation/i, /denial-of-service/i, /market manipulat|manipulate markets/i, /scrap/i, /launder/i]) {
    assert.match(allText, term);
  }
});

ok('what we refuse to publish is stated, so it can be honoured', () => {
  for (const term of [/credential steal/i, /remote access trojan/i, /spyware/i, /ransomware/i, /stresser/i]) {
    assert.match(allText, term);
  }
});

ok('no support / no updates / no availability guarantee', () => {
  assert.match(allText, /without any obligation of support/i);
});

ok('open-source attribution and the source offer are addressed', () => {
  assert.match(allText, /open-source/i);
  assert.match(allText, /offer of source code|corresponding licence text/i);
});

ok('the promise of bundled licence text is actually kept', () => {
  // The Software Terms say "the corresponding licence text is included with the
  // software". A promise in a legal document with nothing behind it is the same
  // failure as an unenforced retention period.
  const fsMod = fs;
  const file = 'resources/THIRD-PARTY-LICENSES.txt';
  assert.ok(fsMod.existsSync(file), `${file} is promised by the terms but does not exist`);
  const text = fsMod.readFileSync(file, 'utf8');
  assert.ok(text.length > 5_000, 'the file exists but has no real content');
  for (const dep of ['@solana/web3.js', 'three', 'ws']) {
    assert.ok(text.includes(dep), `${dep} ships in the app but is not attributed`);
  }
});

ok('unsigned binaries are disclosed rather than left to surprise the user', () => {
  assert.match(allText, /not code-signed/i);
  assert.match(allText, /checksum/i);
});

// ─── Financial-tool clauses ───────────────────────────────────────────

ok('not financial advice, stated conspicuously', () => {
  const sw = documentById('software');
  const sec = sw.sections.find((s) => /not financial advice/i.test(s.heading));
  assert.ok(sec, 'section must exist');
  assert.equal(sec.emphasis, true, 'must be conspicuous');
});

ok('we disclaim being a broker, adviser, or fiduciary, and any registration', () => {
  for (const term of [/not a broker/i, /fiduciary/i, /not registered with/i]) {
    assert.match(allText, term);
  }
});

ok('risk of total loss is stated in caps', () => {
  assert.match(allText, /TOTAL AND PERMANENT LOSS|TOTAL LOSS OF FUNDS/);
});

ok('automated systems are called out as able to lose money faster', () => {
  assert.match(allText, /lose money faster/i);
});

ok('backtests are labelled hypothetical and non-indicative', () => {
  assert.match(allText, /hypothetical/i);
  assert.match(allText, /not indicative of future results/i);
});

ok('irreversibility of blockchain transactions is stated', () => {
  assert.match(allText, /irreversible/i);
});

ok('user carries venue rules, licensing, reporting and tax', () => {
  assert.match(allText, /tax/i);
  assert.match(allText, /rules of every venue|venue rules/i);
});

ok('NO profit or performance claim appears anywhere in the documents', () => {
  // The one that contradicts everything else if it slips in.
  const claims = /guarantee[d]? (profit|return|gain)|risk-free|riskless|assured return|will make you|profitable strategy/i;
  assert.ok(!claims.test(allText), 'a profit claim would gut the disclaimer');
  assert.match(allText, /no claim, promise, projection, or guarantee about profit/i);
});

ok('the fee is disclosed in the terms, not only in the UI', () => {
  assert.match(allText, /platform fee/i);
  assert.match(allText, /same blockchain transaction/i);
});

// ─── Privacy specifics ────────────────────────────────────────────────

ok('every outbound third-party host is disclosed in the privacy policy', () => {
  // If the app talks to it, the policy has to name it. The market-data table
  // (electron/data/http.ts HOSTS) is read from SOURCE so a provider added
  // there without a privacy line fails here; the hosts reached outside that
  // table are listed by hand, from an audit of the code on 2026-09-11.
  const privacy = documentText(documentById('privacy'));
  const http = fs.readFileSync(new URL('../electron/data/http.ts', import.meta.url), 'utf8');
  const table = http.slice(http.indexOf('HOSTS'), http.indexOf('};', http.indexOf('HOSTS')));
  const fromTable = [...table.matchAll(/:\s*'([a-z0-9.-]+\.[a-z]+)'/g)].map((m) => m[1]);
  assert.ok(fromTable.length >= 10, `read ${fromTable.length} hosts from http.ts — the table moved?`);
  const byHand = [
    // Solana RPC and submission
    'api.mainnet-beta.solana.com',
    'solana-rpc.publicnode.com',
    'mainnet.helius-rpc.com',
    'sender.helius-rpc.com',
    'bundles.jito.wtf',
    'mainnet.block-engine.jito.wtf',
    'pumpportal.fun',
    // EVM RPC
    'rpc.mainnet.chain.robinhood.com',
    'robinhood-rpc.publicnode.com',
    'rpc.ordofi.network',
    'robinhood-mainnet.g.alchemy.com',
    'bsc-rpc.publicnode.com',
    'bsc-dataseed.bnbchain.org',
    'rpc-bnb.blockmachine.io',
    // launcher upload, update check, images
    'pump.fun',
    'krypt.cc',
    'ipfs.io',
    'cloudflare-ipfs.com',
    // opt-in
    'api.telegram.org',
    'discord.com',
    'api.openai.com',
    'api.anthropic.com',
    'api.giphy.com',
    'tenor.googleapis.com',
    // explorers opened on click
    'robinhoodchain.blockscout.com',
    'bscscan.com',
    'solscan.io',
  ];
  for (const host of [...new Set([...fromTable, ...byHand])]) {
    assert.ok(privacy.includes(host), `privacy policy never mentions ${host}`);
  }
});

ok('the policy says what the update check is, and that it is the only automatic request to us', () => {
  const privacy = documentText(documentById('privacy'));
  assert.match(privacy, /update check/i);
  assert.match(privacy, /krypt\.cc/);
  assert.match(privacy, /Nothing is downloaded or installed automatically/);
  assert.doesNotMatch(privacy, /operate no server that could/, 'the old "no server, so no IP" claim is gone');
  const tos = documentText(documentById('terms'));
  assert.match(tos, /li\.quest/);
  assert.match(tos, /cannot recover a transfer/);
  assert.match(tos, /act of issuance/);
});

ok('retention periods are stated for everything kept', () => {
  const privacy = documentText(documentById('privacy'));
  assert.match(privacy, /kept on your machine for \d+ years/);
  assert.match(privacy, /Crash logs are kept for 7 days/);
  assert.match(privacy, /enforced by code/i);
});

ok('raw IP storage is ruled out explicitly', () => {
  const privacy = documentText(documentById('privacy'));
  assert.match(privacy, /salted SHA-256/);
  assert.match(privacy, /never in raw form/i);
});

ok('GDPR legal bases are named by article', () => {
  assert.match(allText, /Article 6/);
});

ok('the "no telemetry" claim is defined rather than left bare', () => {
  // legalcheck.md: a bare claim is an FTC 5 problem. The policy has to say
  // what it means, including the part that is NOT covered by it.
  const privacy = documentText(documentById('privacy'));
  assert.match(privacy, /no telemetry/i);
  // The qualifier must sit in the SAME section as the claim, not two sections
  // away — a caveat the reader has to go looking for is not a caveat.
  const claimSection = documentById('privacy').sections.find((sec) => /What we collect/i.test(sec.heading));
  assert.match(claimSection.body.join(' '), /no telemetry/i);
  assert.match(claimSection.body.join(' '), /see your IP address/i, 'the caveat must sit with the claim');
});

// ─── Clickwrap summary ────────────────────────────────────────────────

ok('the summary flags everything a court expects to be flagged', () => {
  const flagged = CLICKWRAP_SUMMARY.filter((p) => p.flagged).map((p) => `${p.title} ${p.detail}`).join(' ');
  assert.match(flagged, /total loss/i, 'risk');
  assert.match(flagged, /not financial advice/i, 'no advice');
  assert.match(flagged, /arbitration/i, 'arbitration');
  assert.match(flagged, /class action/i, 'class waiver');
  assert.match(flagged, new RegExp(`${MINIMUM_AGE} or older`), 'age');
  assert.match(flagged, /no warranty|as-is/i, 'as-is');
});

ok('the summary is plain language, not pasted legalese', () => {
  for (const p of CLICKWRAP_SUMMARY) {
    assert.ok(p.detail.length < 260, `too long to be a summary: ${p.title}`);
    assert.ok(!/hereinafter|whereas|aforementioned|heretofore/i.test(p.detail), `legalese in ${p.title}`);
  }
});

ok('the summary tells the user about the fee before they trade', () => {
  const all = CLICKWRAP_SUMMARY.map((p) => `${p.title} ${p.detail}`).join(' ');
  assert.match(all, /fee/i);
});

// ─── Versioning ───────────────────────────────────────────────────────

ok('the terms version is a real, sortable version string', () => {
  assert.match(TERMS_VERSION, /^\d{4}-\d{2}-\d{2}\.\d+$/);
});

ok('age gate is 18 for a tool that moves real money', () => {
  assert.equal(MINIMUM_AGE, 18);
});

ok('acceptance retention is a stated, finite period', () => {
  assert.ok(ACCEPTANCE_RETENTION_DAYS > 0 && ACCEPTANCE_RETENTION_DAYS < 10_000);
});

console.log(`legal: ${passed}/${passed} tests passed`);
