// The workspace map — the app's top-level organisation.
//
// What this pins is not layout, it is REACHABILITY. Workspaces filter the
// sidebar, so a route that no workspace lists becomes a page the user can
// no longer get to. That is a silent failure: the route still exists, the
// code still compiles, and nothing renders an error — it simply vanishes
// from the menu. So the important test here is the boring one: every route
// the sidebar knows about has a home.

import assert from 'node:assert';
import fs from 'node:fs';
import { WORKSPACES, groupsFor, landingRouteOf, routesFor, workspaceOf, _unmappedRoutes } from './.workspaces.mjs';

// The route list is read from the SOURCE rather than imported: the sidebar
// module carries React components (icons), so bundling it for node would drag
// in the whole renderer. Reading the union means this test cannot drift from
// the real declaration.
const sidebarSrc = fs.readFileSync(new URL('../src/components/Sidebar.tsx', import.meta.url), 'utf8');
const unionText = sidebarSrc.split('export type RouteId =')[1].split(';')[0];
const ROUTES = [...unionText.matchAll(/'([a-z]+)'/g)].map((m) => ({ id: m[1] }));

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push({ name, fn });

const ALL = ROUTES.map((r) => r.id);

test('every route in the sidebar has a workspace, except the ones delisted on purpose', () => {
  assert.ok(ALL.length > 20, `parsed only ${ALL.length} routes — the RouteId union moved`);
  const unmapped = _unmappedRoutes(ALL);
  // `paper` was delisted in 2026-09-06 when paper round trips moved onto the
  // Trades page. It stays a valid RouteId so old state does not break, and it
  // was the only route allowed to have no workspace until 2026-09-22, when the
  // Copier merged into the Wallet list: `copier` stays a valid RouteId (it
  // opens the Wallet list) so a pin or saved state does not break. Anything
  // else here is a page the user can no longer reach.
  assert.deepEqual(unmapped.sort(), ['copier', 'paper'], `unreachable from any workspace: ${unmapped.join(', ')}`);
});

test('no route is OWNED by two workspaces', () => {
  const owners = new Map();
  for (const w of WORKSPACES) {
    for (const r of w.routes) {
      if (owners.has(r)) assert.fail(`${r} is owned by both ${owners.get(r)} and ${w.id}`);
      owners.set(r, w.id);
    }
  }
});

test('a borrowed route still reports its real home', () => {
  // `wallet` is listed under Terminal for convenience (arming) but lives in
  // Wallet Utilities. Listing is navigation; the home is identity.
  assert.equal(workspaceOf('wallet'), 'wallets');
  assert.ok(routesFor('terminal').includes('wallet'), 'Terminal still lists it');
  assert.ok(routesFor('wallets').includes('wallet'), 'and so does its home');
});

test('the three workspaces asked for exist and hold the right pages', () => {
  // Was "Copy Trading" and held one page. Renamed to Automation on
  // 2026-09-13 and given the other two things that act without a click.
  const automation = routesFor('automation');
  for (const r of ['wallets', 'scripts', 'farming']) {
    assert.ok(automation.includes(r), `automation holds ${r}`);
  }

  const engine = routesFor('engine');
  for (const r of ['dashboard', 'launches', 'strategy', 'execution']) {
    assert.ok(engine.includes(r), `main engine holds ${r}`);
  }
  // Scripts LEFT Main Engine — home and listing both. Two menus showing one
  // page is how the flat sidebar became unreadable, so this is not an
  // `extraRoutes` case and a future edit that re-lists it should have to
  // delete this line.
  assert.ok(!engine.includes('scripts'), 'scripts is not listed in Main Engine any more');
  assert.equal(workspaceOf('scripts'), 'automation', 'and its home is Automation');

  const utils = routesFor('wallets');
  for (const r of ['creator', 'funder']) {
    assert.ok(utils.includes(r), `wallet utilities holds ${r}`);
  }
});

test('Widgets is its own workspace and owns the page it opens', () => {
  // The user-arranged dashboard. It is a workspace rather than a page inside
  // one because it belongs to no job in particular — it is whatever the user
  // makes it.
  assert.equal(workspaceOf('workspace'), 'layout', 'the page is owned by the layout workspace');
  assert.deepEqual(routesFor('layout'), ['workspace'], 'and that workspace holds exactly it');
  assert.equal(landingRouteOf('layout'), 'workspace', 'opening the card lands on the page');
});

test('each chain has its own wallet page, and they live together', () => {
  // The ask: separate menu entries per chain, not one page with a switch.
  const utils = routesFor('wallets');
  for (const r of ['wallet', 'walletrobinhood', 'walletbnb']) {
    assert.ok(utils.includes(r), `wallet utilities lists ${r}`);
    assert.equal(workspaceOf(r), 'wallets', `${r} lives in wallet utilities`);
  }
  // And they sit in one section, so they read as a set rather than scattered.
  const section = groupsFor('wallets').find((g) => g.routes.includes('wallet'));
  assert.ok(section, 'the Solana wallet is in a section');
  for (const r of ['walletrobinhood', 'walletbnb']) {
    assert.ok(section.routes.includes(r), `${r} sits with the others, not adrift`);
  }
});

test('Swap is its own page in Wallet Utilities, not a card inside a wallet', () => {
  // It shipped as a section on the Solana wallet page, which buried a tool
  // people open the app to USE underneath a page they open to check a
  // balance. Its own route, its own menu entry, its own heading.
  assert.equal(workspaceOf('swap'), 'wallets');
  assert.ok(routesFor('wallets').includes('swap'));

  const groups = groupsFor('wallets');
  const mine = groups.find((g) => g.routes.includes('swap'));
  assert.ok(mine, 'swap sits under a heading rather than adrift');
  // And NOT inside the wallets group — it is neither a wallet nor part of
  // the Lab's many-wallet machinery.
  assert.ok(!mine.routes.includes('wallet'), 'it is not filed among the wallets themselves');
  assert.ok(!mine.routes.includes('creator'), 'nor inside the Wallet Lab');
});

test('Bridge is its own page, beside Swap and not inside it', () => {
  // A swap is atomic and nobody ever holds your money; a bridge is two
  // transactions with a third party in between. Same workspace, same heading,
  // separate pages — because the warning on one does not apply to the other.
  assert.equal(workspaceOf('bridge'), 'wallets');
  assert.ok(routesFor('wallets').includes('bridge'));
  const tools = groupsFor('wallets').find((g) => g.routes.includes('bridge'));
  assert.ok(tools, 'bridge sits under a heading');
  assert.ok(tools.routes.includes('swap'), 'beside swap');
  assert.notEqual('bridge', 'swap');
});

test('every READY workspace opens on a page it actually lists', () => {
  for (const w of WORKSPACES.filter((x) => x.ready)) {
    const landing = landingRouteOf(w.id);
    assert.ok(routesFor(w.id).includes(landing), `${w.id} opens on ${landing}, which it does not list`);
    assert.ok(ALL.includes(landing), `${w.id} opens on ${landing}, which is not a real route`);
  }
});

test('a workspace that is not ready has no pages, so it cannot be half-entered', () => {
  // The Hub disables a not-ready card, but the map is the real guard: a
  // workspace announced with routes but marked not-ready would be reachable
  // by any other path into it (a deep link, a navigate) and would land the
  // user in a sidebar with pages that were never finished.
  for (const w of WORKSPACES.filter((x) => !x.ready)) {
    assert.deepEqual(routesFor(w.id), [], `${w.id} says it is not ready but lists pages`);
  }
});

test('sidebar sections cover every page the workspace lists, exactly once', () => {
  // A route dropped from every group would vanish from the menu even though
  // the workspace still lists it — the same silent unreachability the map
  // test guards, one level down.
  for (const w of WORKSPACES) {
    const listed = routesFor(w.id);
    const grouped = groupsFor(w.id).flatMap((g) => g.routes);
    assert.deepEqual([...grouped].sort(), [...listed].sort(), `${w.id}: sections and listing disagree`);
    /* eslint-disable-next-line no-unused-expressions */
    assert.equal(new Set(grouped).size, grouped.length, `${w.id}: a route appears in two sections`);
  }
});

test('a workspace with no sections of its own still renders one plain list', () => {
  // Automation names no groups: three items do not need headings, and "a lone
  // heading over every item in the menu is decoration".
  const automation = groupsFor('automation');
  assert.equal(automation.length, 1);
  assert.equal(automation[0].label, null, 'no headings over a three-item menu');
  assert.deepEqual(automation[0].routes, routesFor('automation'));
});

test('Farming is reachable but ships with nothing running', () => {
  // It is a placeholder in Automation so the shape of the workspace is
  // visible while the feature is designed. Two separate pieces of work in
  // this repo (2026-08-15 returns ceiling; the 2026-09-09 airdrop swarm)
  // found the obvious versions do not pay, and the page says so rather than
  // pretending to be a feature.
  assert.equal(workspaceOf('farming'), 'automation');
  assert.ok(routesFor('automation').includes('farming'));
  const src = fs.readFileSync(new URL('../src/pages/Farming.tsx', import.meta.url), 'utf8');
  assert.match(src, /Not built yet/, 'the page says plainly that nothing runs');
  // It prices a run but must not BE one: no trade call, nothing armed.
  for (const forbidden of ['live.buy', 'live.sell', 'live.sellToken', 'lab.start', 'setLive']) {
    assert.ok(!src.includes(forbidden), `the preset page must not call ${forbidden}`);
  }
});

test('the AI connection (MCP) is a page under Automation, and Settings points to it', () => {
  // Moved out of Settings on 2026-09-23: users did not know it existed.
  assert.equal(workspaceOf('mcp'), 'automation');
  assert.ok(routesFor('automation').includes('mcp'));
  assert.match(sidebarSrc, /\{ id: 'mcp', label: 'AI connection'/);
  const page = fs.readFileSync(new URL('../src/pages/AiConnection.tsx', import.meta.url), 'utf8');
  assert.match(page, /<McpPanel \/>/, 'the page carries the panel');
  assert.match(page, /Model Context Protocol/, 'and says what MCP is in plain words');
  const settings = fs.readFileSync(new URL('../src/pages/Settings.tsx', import.meta.url), 'utf8');
  assert.ok(!/<McpPanel/.test(settings), 'one home: Settings does not render the panel too');
  assert.match(settings, /onNavigate\('mcp'\)/, 'but it points to the new page');
  const guides = fs.readFileSync(new URL('../src/pages/Guides.tsx', import.meta.url), 'utf8');
  assert.match(guides, /Open Automation from the Hub\. In the menu on the left, press AI connection\./, 'the guide sends people to the right place');
  assert.ok(!/Open Settings and find AI connection/.test(guides), 'and not the old one');
});

test('Guides has a plain-words guide for every tile on the Hub', () => {
  // Rewards became Guides on 2026-09-20; the reward check moved to the
  // Robinhood and BNB wallet pages. The Guides page is keyed by workspace
  // id, so a tile added to the Hub without a guide fails here.
  const w = WORKSPACES.find((x) => x.id === 'guides');
  assert.ok(w, 'the guides workspace exists');
  assert.equal(w.title, 'Guides');
  assert.ok(w.ready, 'it has a page, so it is enterable');
  assert.deepEqual(routesFor('guides'), ['guides']);
  assert.equal(WORKSPACES.find((x) => x.id === 'rewards'), undefined, 'Rewards is gone');
  const page = fs.readFileSync(new URL('../src/pages/Guides.tsx', import.meta.url), 'utf8');
  for (const ws of WORKSPACES) assert.ok(new RegExp(`^  ${ws.id}: \\{`, 'm').test(page), `Guides.tsx has a guide for ${ws.id}`);
  assert.ok(/START_GUIDE/.test(page) && /Start here/.test(page), 'and a Start here guide before them');
  // Plain words: every step is one short line.
  const steps = [...page.matchAll(/^\s{6}'([^']{20,})',$/gm)].map((m) => m[1]);
  assert.ok(steps.length >= 30, `guides carry steps (${steps.length})`);
  for (const st of steps) assert.ok(st.length <= 170, `a step stays short: ${st.slice(0, 60)}…`);
  // The reward check lives on the EVM wallet pages now, and the old page is gone.
  const wallet = fs.readFileSync(new URL('../src/pages/Wallet.tsx', import.meta.url), 'utf8');
  assert.ok(/<WalletRewards chain=\{chain\} \/>/.test(wallet), 'the EVM wallet page carries Check my rewards');
  assert.ok(!fs.existsSync(new URL('../src/pages/Rewards.tsx', import.meta.url)), 'Rewards.tsx is gone');
  const rewards = fs.readFileSync(new URL('../src/components/terminal/WalletRewards.tsx', import.meta.url), 'utf8');
  // Code only: the header comment names the fields it refuses to render.
  const rewardsCode = rewards.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
  assert.ok(!/href=|openExternal|depositUrl|explorerAddress/.test(rewardsCode), 'the reward block renders no third-party link — a claim link is how wallets get drained');
  assert.ok(/window\.krypt\.rewards\.wallet\(chain\)/.test(rewards) && /useCallback/.test(rewards), 'the address leaves only on the button');
  const legal = fs.readFileSync(new URL('../shared/legal/documents.ts', import.meta.url), 'utf8');
  assert.ok(/Reward rates \(the Robinhood Chain and BNB wallet pages\)/.test(legal), 'the privacy policy names where the check lives');
});

test('the hub is not a workspace you can be inside', () => {
  // 'hub' is a state of the shell, not a page list. If it ever gained routes
  // the sidebar would render behind the hub, which is the bug this catches.
  assert.equal(
    WORKSPACES.find((w) => w.id === 'hub'),
    undefined,
  );
  assert.deepEqual(routesFor('hub'), []);
});

test('workspaceOf never throws, whatever it is handed', () => {
  // A route added to the sidebar and forgotten here must still be reachable.
  assert.equal(typeof workspaceOf('not-a-route'), 'string');
});

const run = async () => {
  for (const c of cases) {
    try {
      await c.fn();
      passed += 1;
      console.log(`ok  ${c.name}`);
    } catch (e) {
      console.log(`FAIL ${c.name}\n  ${e.message}`);
    }
  }
  console.log(`workspaces: ${passed}/${cases.length} passed`);
  if (passed !== cases.length) process.exit(1);
};

await run();
