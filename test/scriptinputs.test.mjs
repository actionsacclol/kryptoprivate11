// Settings a script asks for before it runs.
//
// A code script declares them in its own source and reads the answers from
// `bot.input`. The two things these checks protect:
//
//   • a value reaches the script in its DECLARED shape, whatever the form or a
//     hand-edited settings file contained. A script reading `bot.input.gap[0]`
//     should get a number, and a range should already be low-to-high.
//
//   • a malformed declaration is REPORTED, not ignored. A script that silently
//     drops the settings its author wrote is worse than one that refuses.

import assert from 'node:assert';
import fs from 'node:fs';
import {
  MAX_INPUTS,
  MAX_LINES,
  coerceInputs,
  defaultsFor,
  hasInputs,
  inputsBlock,
  inputsProblem,
  parseInputs,
  inputsForScript,
} from './.scriptinputs.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`ok  ${label}`);
  passed += 1;
};
const src = (p) => fs.readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

const CODE = `/* @inputs
{
  "mint":  { "type": "mint",   "label": "Coin" },
  "gap":   { "type": "range",  "label": "Gap", "default": [5, 10], "min": 1, "max": 120 },
  "lines": { "type": "lines",  "label": "Say" },
  "n":     { "type": "number", "label": "How many", "default": 3, "min": 0, "max": 20 },
  "note":  { "type": "text",   "label": "Note", "optional": true }
}
*/
bot.log(bot.input.mint);`;

{
  const { specs, error } = parseInputs(CODE);
  assert.equal(error, null);
  assert.deepEqual(Object.keys(specs), ['mint', 'gap', 'lines', 'n', 'note']);
  assert.equal(specs.mint.label, 'Coin');
  assert.equal(specs.note.optional, true);
  // A script with no block asks for nothing, and that is not an error.
  assert.deepEqual(parseInputs('bot.log(1)'), { specs: {}, error: null });
  assert.equal(hasInputs(parseInputs('bot.log(1)').specs), false);
  assert.equal(inputsBlock('bot.log(1)'), null);
  ok('a script declares its settings in its own source, or declares none');
}

{
  // A BROKEN BLOCK IS REPORTED. Silently ignoring it would leave a script
  // reading undefined for settings its author plainly wrote.
  assert.match(parseInputs('/* @inputs { nope } */').error, /not valid JSON/);
  assert.match(parseInputs('/* @inputs [1,2] */').error, /must be a JSON object/);
  assert.match(parseInputs('/* @inputs {"a":{"type":"wat","label":"A"}} */').error, /unknown type/);
  assert.match(parseInputs('/* @inputs {"a":{"type":"select","label":"A"}} */').error, /non-empty "options"/);
  // The name becomes `bot.input.<name>`, so it has to be a plain identifier.
  assert.match(parseInputs('/* @inputs {"a-b":{"type":"text","label":"A"}} */').error, /not a usable name/);
  assert.match(parseInputs('/* @inputs {"2x":{"type":"text","label":"A"}} */').error, /not a usable name/);
  ok('a declaration that cannot be read says so instead of being dropped');
}

{
  // THE DECLARED SHAPE, whatever arrived. This is the whole contract with the
  // script: it should never have to defend against its own settings.
  const { specs } = parseInputs(CODE);
  const v = coerceInputs(specs, { mint: '  abc  ', gap: ['9', '2'], lines: 'a\n\n b ', n: '999', note: 42 });
  assert.equal(v.mint, 'abc', 'text is trimmed');
  assert.deepEqual(v.gap, [2, 9], 'a backwards range comes back low-to-high');
  assert.deepEqual(v.lines, ['a', 'b'], 'lines split, trim and drop blanks');
  assert.equal(v.n, 20, 'a number is clamped to its declared max');
  assert.equal(v.note, '42', 'and everything is the declared type');
  // Missing answers become the empty shape, never undefined.
  const empty = coerceInputs(specs, {});
  assert.deepEqual(empty.lines, []);
  assert.deepEqual(empty.gap, [5, 10], 'an unanswered range takes its declared default (was [min, min] before 2026-09-23)');
  assert.equal(typeof empty.n, 'number');
  // Caps, so a pasted novel cannot become a thousand entries.
  assert.equal(coerceInputs(specs, { lines: Array(500).fill('x') }).lines.length, MAX_LINES);
  ok('a script always gets its settings in the shape it declared');
}

{
  // Defaults come from the script, and an unanswered REQUIRED field is what
  // blocks it running — an optional one never does.
  const { specs } = parseInputs(CODE);
  const d = defaultsFor(specs);
  assert.deepEqual(d.gap, [5, 10], 'the script’s own default');
  assert.equal(d.n, 3);
  assert.match(inputsProblem(specs, d), /Coin needs an answer/);
  assert.equal(inputsProblem(specs, { ...d, mint: 'x', lines: ['a'] }), null, 'answered is answered');
  assert.equal(inputsProblem(specs, { ...d, mint: 'x', lines: ['a'], note: '' }), null, 'an optional blank is fine');
  // A range is never "empty" — it is always two numbers.
  assert.equal(inputsProblem({ g: { type: 'range', label: 'G' } }, {}), null);
  ok('the script’s own defaults fill the form, and a blank required field blocks it');
}

{
  const many = {};
  for (let i = 0; i < 40; i += 1) many[`f${i}`] = { type: 'text', label: `F${i}` };
  const over = parseInputs(`/* @inputs ${JSON.stringify(many)} */`);
  assert.deepEqual(over.specs, {}, 'over the ceiling is refused whole, never trimmed');
  assert.match(over.error, /declares 40 fields; a form holds at most/);
  // Exactly at the ceiling is fine — and nothing past field 16 goes missing.
  const full = {};
  for (let i = 0; i < MAX_INPUTS; i += 1) full[`f${i}`] = { type: 'text', label: `F${i}` };
  const atCap = parseInputs(`/* @inputs ${JSON.stringify(full)} */`);
  assert.equal(atCap.error, null);
  assert.equal(Object.keys(atCap.specs).length, MAX_INPUTS);
  ok('a declaration over the ceiling is reported, not silently cut');
}

{
  // THE ANSWERS RIDE WITH THE CODE, and are coerced against the code they are
  // being run with — not against whatever the block said when they were last
  // answered. Editing the block without re-opening the form must not hand a
  // script yesterday's shape.
  const auto = src('../electron/engine/automation.ts');
  const start = auto.slice(auto.indexOf('const { inputsForScript, parseInputs }'), auto.indexOf('const r = await h.sandbox.start'));
  assert.match(start, /inputsForScript\(parseInputs\(s\.code\)\.specs, s\.inputs \?\? \{\}\)/, 'coerced against the code being started');

  const ipc = src('../electron/ipc.ts');
  assert.match(ipc, /inputs: coerceInputs\(/, 'and again on save');
  assert.match(ipc, /parseInputs\(typeof r\.code === 'string' \? r\.code : ''\)\.specs/, 'against the code being saved');

  // Frozen in the sandbox: a handler cannot rewrite what the run was given.
  const proto = src('../shared/scriptProtocol.ts');
  assert.match(proto, /input = Object\.freeze\(m\.inputs\)/, 'the answers are frozen');
  assert.match(proto, /get input\(\) \{ return input; \}/, 'and exposed as bot.input');
  ok('the answers are coerced against the running code, and frozen inside it');
}

{
  // PRESSING ON ASKS. A script run with its settings unanswered would work
  // against blanks and fail in a way that reads as the script being broken —
  // so the form is part of starting it, not a thing to find first.
  const page = src('../src/pages/Scripts.tsx');
  // Pressing On ASKS rather than refusing: a switch that will not move, with
  // the reason in small text beside it, is the version people file as a bug.
  assert.match(page, /if \(v && inputs\.problem\) \{/, 'On with unanswered settings opens the form');
  assert.match(page, /setArmAfterInputs\(true\);/, 'and remembers why it opened');
  // Answering it saves BEFORE arming: the engine starts the stored script, not
  // the draft on screen, so arming first would run the old answers.
  assert.ok(
    page.indexOf('if (!(await save(answered))) return;') < page.indexOf('await toggle({ ...saved, ...answered }'),
    'the answers are saved before the script is armed',
  );
  // A form closed without finishing arms nothing.
  assert.match(page, /if \(inputsProblem\(inputs\.specs, next\)\)/, 'an incomplete form still does not arm');
  assert.match(page, /useScriptInputs\(draft\?\.kind === 'code'/, 'read from the draft being edited');
  const dlg = src('../src/components/terminal/ScriptInputsDialog.tsx');
  assert.match(dlg, /role="dialog"/, 'it is a real dialog');
  assert.match(dlg, /e\.key === 'Escape'/, 'escape closes it');
  assert.match(dlg, /onDone\(coerceInputs\(specs, draft\)\)/, 'and what it hands back is already in shape');
  ok('pressing On opens the form, and answering it saves then arms');
}

{
  // The fields could not be typed in (2026-09-23): the dialog took focus in an
  // effect keyed on `onClose`, which the Scripts page passes inline, so every
  // re-render (about once a second while scripts run) pulled focus back out of
  // the box. Focus is taken once, on open; Escape reads onClose through a ref.
  const dlg = fs.readFileSync('src/components/terminal/ScriptInputsDialog.tsx', 'utf8').replace(/\r\n/g, '\n');
  const eff = dlg.slice(dlg.indexOf('panel.current?.focus();') - 40, dlg.indexOf('panel.current?.focus();') + 400);
  assert.match(eff, /\}, \[\]\);/, 'focus is taken once, not on every render');
  assert.doesNotMatch(dlg, /\}, \[onClose\]\);/, 'nothing re-runs because onClose is a new function');
  assert.match(dlg, /onCloseRef\.current\(\)/, 'Escape still closes, through the latest onClose');
  ok('the settings form keeps focus in the box being typed in');
}

// A webhook setting (2026-09-23). Its value is a credential and the one URL
// a script's post can go to, so: Discord only, never shown to the script,
// and the post names the FIELD, not a URL.
{
  const HOOK = 'https://discord.com/api/webhooks/123456789012345678/S3cr3tTok3n';
  const { specs, error } = parseInputs('/* @inputs\n{ "calls": { "type": "webhook", "label": "Calls channel", "optional": true } }\n*/');
  assert.equal(error, null);
  assert.equal(specs.calls.type, 'webhook');
  assert.equal(coerceInputs(specs, { calls: HOOK }).calls, HOOK, 'a Discord webhook is kept');
  assert.equal(coerceInputs(specs, { calls: 'https://evil.example/api/webhooks/1/2' }).calls, '', 'any other host is blanked');
  assert.match(inputsProblem(specs, { calls: 'https://evil.example/x' }), /Calls channel: only Discord webhooks/, 'and said out loud');
  assert.equal(inputsProblem(specs, { calls: '' }), null, 'blank is off, not a problem');
  const seen = inputsForScript(specs, { calls: HOOK }).calls;
  assert.ok(!seen.includes('S3cr3tTok3n'), 'the sandbox never gets the token');
  assert.ok(seen.length > 0, 'but it can tell the field is set');
  assert.equal(inputsForScript(specs, { calls: '' }).calls, '');

  const autos = src('../electron/engine/automation.ts');
  const d = autos.slice(autos.indexOf("case 'discord': {"), autos.indexOf("case 'follow':"));
  assert.match(d, /specs\[key\]\?\.type !== 'webhook'/, 'bot.discord only names a declared webhook field');
  assert.match(d, /coerceInputs\(specs, s\.inputs \?\? \{\}\)\[key\]/, 'the URL comes from the saved answers, not the sandbox');
  assert.match(d, /redactWebhook\(url\)/, 'and the log line never carries it');
  assert.match(autos, /inputsForScript\(parseInputs\(s\.code\)\.specs/, 'the sandbox is started with the redacted answers');
  ok('a webhook setting is Discord-only, hidden from the script, and named not passed');
}

// A field added to a script that was already answered (2026-09-23): it
// takes its own default, not its minimum. The bug: a new "stop loss %"
// read 0 and a new "skip above curve %" read 1 until the form was reopened.
{
  const { specs } = parseInputs('/* @inputs\n{ "old": { "type": "number", "label": "Old", "default": 5, "min": 0, "max": 9 }, "stop": { "type": "number", "label": "Stop", "default": 60, "min": 0, "max": 95 }, "cap": { "type": "number", "label": "Cap", "default": 80, "min": 1, "max": 100 } }\n*/');
  const v = coerceInputs(specs, { old: 7 });
  assert.equal(v.old, 7, 'an answer given is kept');
  assert.equal(v.stop, 60, 'a new field takes its default, not 0');
  assert.equal(v.cap, 80, 'and not its minimum');
  assert.equal(coerceInputs(specs, { stop: 0 }).stop, 0, 'a deliberate 0 is still 0');
  ok('a newly added field starts at its own default');
}

console.log(`\nscriptinputs: ${passed}/${passed} passed`);
