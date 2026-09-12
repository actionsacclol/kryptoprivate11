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

test('every route in the sidebar has a workspace, except the one delisted on purpose', () => {
  assert.ok(ALL.length > 20, `parsed only ${ALL.length} routes — the RouteId union moved`);
  const unmapped = _unmappedRoutes(ALL);
  // `paper` was delisted in 2026-09-06 when paper round trips moved onto the
  // Trades page. It stays a valid RouteId so old state does not break, and it
  // is the ONLY route allowed to have no workspace. Anything else here is a
  // page the user can no longer reach.
  assert.deepEqual(unmapped, ['paper'], `unreachable from any workspace: ${unmapped.join(', ')}`);
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
  const copy = routesFor('copy');
  assert.ok(copy.includes('wallets'), 'copy trading holds the follow-a-wallet page');

  const engine = routesFor('engine');
  for (const r of ['dashboard', 'launches', 'scripts', 'strategy', 'execution']) {
    assert.ok(engine.includes(r), `main engine holds ${r}`);
  }

  const utils = routesFor('wallets');
  for (const r of ['creator', 'funder', 'warmer', 'copier']) {
    assert.ok(utils.includes(r), `wallet utilities holds ${r}`);
  }
});

test('My Layout is its own workspace and owns the page it opens', () => {
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
  const copy = groupsFor('copy');
  assert.equal(copy.length, 1);
  assert.equal(copy[0].label, null, 'no heading over a single-item menu');
  assert.deepEqual(copy[0].routes, routesFor('copy'));
});

test('Rewards states what you earn — it is not an airdrop hunter', () => {
  // The name and the shape are the finding, not decoration
  // (docs/airdrop-research-2026-09-09.md). A future edit that turns this back
  // into a hunt should have to delete a test that says why.
  const w = WORKSPACES.find((x) => x.id === 'rewards');
  assert.ok(w, 'the rewards workspace exists');
  assert.equal(w.title, 'Rewards');
  assert.doesNotMatch(w.title, /airdrop|hunt/i, 'not a hunt');
  assert.ok(w.ready, 'it has a page, so it is enterable');
  assert.deepEqual(routesFor('rewards'), ['rewards']);
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
