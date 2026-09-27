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

{
  // 2026-09-26: "after starting a script I have to widen the window to see
  // Settings and Stop". A bare `1fr` track has an auto (min-content) floor,
  // and a running script's log lines (SCORE json, mints, URLs) only had
  // `break-words`, which does not lower min-content. So the editor column
  // grew past the window and the header card's controls went off-screen.
  const listView = at("{view === 'scripts' && (");
  const editor = at('{/* Editor */}', listView);
  const grid = src.slice(listView, at('<ChainTabs', listView));
  assert.ok(/lg:grid-cols-\[300px_minmax\(0,1fr\)\]/.test(grid), 'the editor track is minmax(0,1fr), never a bare 1fr');
  assert.ok(!/grid-cols-\[300px_1fr\]/.test(src), 'no bare 1fr track left');
  assert.ok(/^\s*<div className="space-y-4 min-w-0">/m.test(src.slice(editor, editor + 200)), 'the editor column is min-w-0');
  const log = src.slice(at('function ScriptLog('));
  assert.ok(/<span className="min-w-0 flex-1 whitespace-pre-wrap \[overflow-wrap:anywhere\]">\{l\.line\}<\/span>/.test(log), 'a log line wraps anywhere inside its own row');
  assert.ok(/overflow-x-hidden/.test(log.slice(0, 1500)), 'the log box never scrolls sideways');
  const stats = src.slice(at('{currentStats && ('), at('{currentStats && (') + 300);
  assert.ok(/\[overflow-wrap:anywhere\]/.test(stats), 'the header card stats line (last error) wraps');
  // The controls sit in the header card's wrapping row, not in the log.
  const header = src.slice(at('<Card className="space-y-2 border-krypt-purple/25">'), at('<Field label="Kind">'));
  assert.ok(/<div className="flex flex-wrap items-center gap-3">/.test(header) && /checked=\{current\.enabled\}/.test(header) && /Settings\n/.test(header), 'Settings and the arm switch are in the wrapping header row');
  assert.ok(!/grid-cols-\[auto_auto_auto\]/.test(src), 'the Kind/Chain/Mode row wraps rather than setting a min width');
  const common = fs.readFileSync(new URL('../src/components/common.tsx', import.meta.url), 'utf8');
  assert.ok(/text-krypt-muted\/80 mt-1 \[overflow-wrap:anywhere\]">\{description\}/.test(common), 'a Section description (the log’s last error) wraps');
  ok('long log lines and errors wrap; the editor never widens the page past its controls');
}

console.log(`\nscriptspage: ${passed}/${passed} passed`);
