// Which URLs a window carrying window.krypt may navigate to (2026-10-23).
// The guard was a prefix test that let in localhost.<anything>, any file on
// disk, and file:// network shares.

import assert from 'node:assert';
import fs from 'node:fs';
import { isAppUrl } from './.appurl.mjs';

let passed = 0;
const ok = (label) => {
  console.log(`  ok   ${label}`);
  passed += 1;
};

const packaged = { indexUrl: 'file:///C:/Program%20Files/Krypto%20Bot/resources/app.asar/dist/index.html' };
const dev = { indexUrl: 'file:///C:/src/KryptSniper/dist/index.html', devUrl: 'http://localhost:5273/' };

{
  assert.ok(isAppUrl(packaged.indexUrl, packaged), 'the app page itself');
  assert.ok(isAppUrl(`${packaged.indexUrl}#panel=chart`, packaged), 'with a hash (panel windows)');
  assert.ok(isAppUrl(`${packaged.indexUrl}?x=1`, packaged), 'with a query');
  assert.ok(isAppUrl('file:///c:/program files/krypto bot/resources/app.asar/dist/INDEX.HTML', packaged), 'Windows paths are case-insensitive, escaped or not');
  ok('the app’s own index.html is allowed, however it is spelled');
}

{
  for (const bad of [
    'file:///C:/Users/me/Downloads/evil.html',
    'file:///C:/Program%20Files/Krypto%20Bot/resources/app.asar/dist/other.html',
    'file://attacker-host/share/index.html',
    'file://attacker-host/C:/Program%20Files/Krypto%20Bot/resources/app.asar/dist/index.html',
    'http://localhost/',
    'http://localhost.attacker.com/',
    'http://127.0.0.1.attacker.com/',
    'https://evil.com/',
    'javascript:alert(1)',
    'not a url',
  ]) {
    assert.equal(isAppUrl(bad, packaged), false, `refused: ${bad}`);
  }
  ok('any other file, a network share, localhost look-alikes and the web are refused');
}

{
  assert.ok(isAppUrl('http://localhost:5273/', dev), 'the dev server');
  assert.ok(isAppUrl('http://localhost:5273/#panel=x', dev), 'the dev server with a hash');
  assert.equal(isAppUrl('http://localhost:5274/', dev), false, 'another port is another origin');
  assert.equal(isAppUrl('http://localhost:5273.attacker.com/', dev), false, 'a look-alike host');
  assert.equal(isAppUrl('http://localhost:5273/', packaged), false, 'no dev server in a packaged build');
  ok('the dev server is matched by exact origin, and only when one is configured');
}

{
  const guard = fs.readFileSync(new URL('../electron/system/webSecurity.ts', import.meta.url), 'utf8');
  assert.ok(/if \(!isAppUrl\(url, own\)\)/.test(guard), 'will-navigate uses the exact check');
  assert.ok(!/url\.startsWith\('file:\/\/'\)/.test(guard), 'the prefix test is gone');
  const main = fs.readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
  assert.equal((main.match(/guardWebContents\(win, ownPage\(/g) ?? []).length, 2, 'both windows carrying window.krypt pass their own page');
  const entry = fs.readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.ok(/addEventListener\('drop', \(e\) => e\.preventDefault\(\)\)/.test(entry), 'a dropped link or file never navigates the window');
  ok('both windows use it, and a drop cannot navigate');
}

console.log(`\nappurl: ${passed}/${passed} passed`);
