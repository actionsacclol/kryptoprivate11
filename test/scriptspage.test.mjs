// The Scripts page's shape (2026-09-20), pinned from source. The user's
// complaint: the arm switch sat under the whole editor, new scripts shared
// the list's column, and the API / variable / AI-prompt material hung off
// the code editor. Now: a top bar with three views, the controls in a
// header card above the editor, and a Reference view for the reading.

import assert from 'node:assert';
import fs from 'node:fs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const src = fs.readFileSync(new URL('../src/pages/Scripts.tsx', import.meta.url), 'utf8');
const at = (marker, after = 0) => {
  const i = src.indexOf(marker, after);
  assert.ok(i >= 0, `Scripts.tsx has ${marker.slice(0, 60)}`);
  return i;
};

{
  // Three views under one top bar, rendered as the page's header actions.
  assert.ok(/\['scripts', 'My scripts', ListChecks\]/.test(src) && /\['new', 'New', Plus\]/.test(src) && /\['reference', 'Reference', BookOpen\]/.test(src), 'the three views');
  assert.ok(/role="tablist" aria-label="Scripts views"/.test(src), 'the top bar is a tablist');
  const actions = at('actions={');
  const tabs = at('VIEWS.map(([id, label, Icon])');
  assert.ok(tabs > actions && tabs - actions < 400, 'the view tabs are the page header’s actions');
  ok('a top bar separates My scripts, New and Reference');
}

{
  // In the editor, the arm switch, Save and Delete sit in a header card ABOVE
  // the settings, the rules/code editor and the log.
  const page = at('export function ScriptsPage() {');
  const editorStart = at("{view === 'scripts' && (", page);
  const armSwitch = at('checked={current.enabled}', editorStart);
  const settings = at('<Field label="Kind">', editorStart);
  const editors = at('<RulesEditor draft={draft}', editorStart);
  const log = at('<ScriptLog lines=', editorStart);
  assert.ok(armSwitch < settings && settings < editors && editors < log, 'header card (arm switch) → settings → editor → log');
  const save = at("draft.id ? 'Save changes' : 'Save (paper, off)'", editorStart);
  assert.ok(save < settings, 'Save is in the header card too');
  ok('the arm switch and Save sit above the editor, not under it');
}

{
  // New scripts have their own view; the list column only lists.
  const newView = at("{view === 'new' && (");
  const rule = at("startNew('rules')", newView);
  const script = at("startNew('code')", newView);
  const listView = at("{view === 'scripts' && (");
  assert.ok(rule < listView && script < listView, 'the New view holds the two start buttons');
  const listBody = src.slice(listView, at('{/* Editor */}', listView));
  assert.ok(!/startNew\(/.test(listBody), 'the list column no longer creates scripts; it links to New');
  assert.ok(/setView\('new'\)/.test(listBody), 'and it links to New');
  ok('creating a script is its own view');
}

{
  // Reference holds the reading material; the code editor points at it.
  const ref = at('function ReferenceView(');
  const body = src.slice(ref);
  assert.ok(/\{SCRIPT_API_DOC\}/.test(body), 'the bot API is under Reference');
  assert.ok(/<VariableGuide guideChain=\{guideChain\} \/>/.test(body), 'the variable guide is under Reference, per chain');
  assert.ok(/copyText\(aiPromptPack\(\)\)/.test(body), 'the AI prompt is under Reference');
  assert.ok(/SCRIPT_EXAMPLES\.map\(\(ex\) =>/.test(body) && /onUseExample\(ex\)/.test(body), 'the examples are under Reference and can start a script');
  const ce = at('function CodeEditor(');
  const ceBody = src.slice(ce, ref > ce ? ref : undefined);
  assert.ok(!/panel === 'api'/.test(ceBody) && !/<VariableGuide/.test(ceBody), 'the code editor no longer carries side panels');
  assert.ok(/onReference\('api'\)/.test(ceBody) && /onReference\('vars'\)/.test(ceBody), 'it points at Reference instead');
  ok('API, variables, AI prompt and examples live under Reference');
}

console.log(`\nscriptspage: ${passed}/${passed} passed`);
