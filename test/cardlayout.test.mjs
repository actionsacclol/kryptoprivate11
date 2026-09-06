// A share card is drawn on a canvas: text does not wrap or reflow, it just
// overlaps. These are the geometry rules that stop a card shipping with its
// result line through its footer.
import assert from 'node:assert';
import { CARD_H, CARD_PAD, MIN_GAP, cardLayout } from './.cardlayout.mjs';

const cases = [
  { rows: 0, pnl: false },
  { rows: 0, pnl: true },
  { rows: 1, pnl: true },
  { rows: 2, pnl: true },  // open position: entry, now
  { rows: 3, pnl: true },  // closed trade: in, out, held — the one that collided
  { rows: 4, pnl: true },
];

for (const c of cases) {
  const l = cardLayout(c.rows, c.pnl);
  const baselines = [l.ticker, l.big, ...l.rows, ...(l.pnl === null ? [] : [l.pnl]), l.bottom];
  const label = `${c.rows} row(s)${c.pnl ? ' + result' : ''}`;

  for (let i = 1; i < baselines.length; i++) {
    assert.ok(baselines[i] > baselines[i - 1], `${label}: baselines must run down the card`);
    assert.ok(
      baselines[i] - baselines[i - 1] >= MIN_GAP,
      `${label}: ${baselines[i - 1]} and ${baselines[i]} are ${baselines[i] - baselines[i - 1]}px apart, closer than one line`,
    );
  }
  assert.ok(l.ticker > CARD_PAD + 60, `${label}: the ticker clears the wordmark`);
  assert.ok(l.bottom <= CARD_H - 40, `${label}: the bottom line stays inside the plate`);
  assert.equal(l.rows.length, c.rows, `${label}: every row gets a baseline`);
  console.log(`ok  ${label}: nothing overlaps`);
}

// The case that shipped broken: three rows and a result used to put the
// result at 602 with the footer at 579.
{
  const l = cardLayout(3, true);
  assert.ok(l.pnl !== null && l.pnl < l.bottom - MIN_GAP, 'the result line clears the footer');
  console.log('ok  a closed trade card clears its own footer');
}
console.log('cardlayout: all tests passed');
