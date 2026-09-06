// Auto-sell templates. The expansion is what matters: a ladder that arms an
// invalid order, or one the user did not ask for, is worse than no template.
import assert from 'node:assert';
import {
  BUILT_IN_TEMPLATES,
  MAX_TAKE_PROFITS,
  describeTemplate,
  emptyTemplate,
  ordersForTemplate,
  validateTemplate,
} from './.ordertemplates.mjs';

const MINT = 'So11111111111111111111111111111111111111112';

{
  // Every shipped template must be valid and must expand to real orders.
  for (const t of BUILT_IN_TEMPLATES) {
    const v = validateTemplate(t);
    assert.equal(v.ok, true, `${t.name}: ${v.message}`);
    const orders = ordersForTemplate(t, MINT, 'TEST');
    assert.ok(orders.length > 0, `${t.name} arms something`);
    for (const o of orders) {
      assert.equal(o.mint, MINT);
      assert.ok(o.amount > 0 && o.amount <= 100, `${t.name}: ${o.kind} sells a sane share`);
    }
  }
  assert.equal(validateTemplate(emptyTemplate('x')).ok, true, 'a new template starts valid');
  console.log('ok  every shipped template is valid and arms real orders');
}

{
  const t = BUILT_IN_TEMPLATES.find((x) => x.name === 'Runner');
  const kinds = ordersForTemplate(t, MINT, 'TEST').map((o) => o.kind);
  assert.deepEqual(kinds, ['stop_loss', 'take_profit', 'take_profit', 'trailing_stop', 'sell_on_dev_sell']);
  const tps = ordersForTemplate(t, MINT, 'TEST').filter((o) => o.kind === 'take_profit');
  assert.deepEqual(tps.map((o) => o.triggerValue), [100, 300], 'ladder keeps its order');
  assert.deepEqual(tps.map((o) => o.amount), [40, 50], 'each step sells its share of what is left');
  console.log('ok  a ladder expands in order, with each step sizing itself');
}

{
  // Guards. Each of these is a way a template could arm nonsense.
  const base = emptyTemplate('t');
  assert.equal(validateTemplate({ ...base, name: '' }).ok, false, 'needs a name');
  assert.equal(validateTemplate({ ...base, stopLossPct: 0 }).ok, false, 'a 0 % stop is not a stop');
  assert.equal(validateTemplate({ ...base, stopLossPct: 100 }).ok, false, 'a 100 % stop cannot trigger');
  assert.equal(validateTemplate({ ...base, trailingPct: 150 }).ok, false, 'trailing must be a percentage');
  assert.equal(
    validateTemplate({ ...base, takeProfits: [{ gainPct: 100, sellPct: 120 }] }).ok,
    false,
    'cannot sell 120 % of a position',
  );
  assert.equal(
    validateTemplate({ ...base, takeProfits: [{ gainPct: 200, sellPct: 50 }, { gainPct: 100, sellPct: 50 }] }).ok,
    false,
    'a ladder that goes backwards is a mistake, not a strategy',
  );
  assert.equal(
    validateTemplate({ ...base, takeProfits: Array.from({ length: MAX_TAKE_PROFITS + 1 }, (_, i) => ({ gainPct: (i + 1) * 50, sellPct: 10 })) }).ok,
    false,
    'the ladder is bounded',
  );
  assert.equal(
    validateTemplate({ ...base, stopLossPct: null, takeProfits: [], trailingPct: null, sellOnDevSell: false }).ok,
    false,
    'a template that arms nothing is refused',
  );
  console.log('ok  a template cannot arm nonsense');
}

{
  // The description is what the user reads before arming it, so it must
  // name everything that will be placed.
  const t = BUILT_IN_TEMPLATES.find((x) => x.name === 'Runner');
  const d = describeTemplate(t);
  assert.match(d, /stop -35%/);
  assert.match(d, /\+100% sell 40%/);
  assert.match(d, /\+300% sell 50%/);
  assert.match(d, /trailing 30%/);
  assert.match(d, /dev sells/);
  const orders = ordersForTemplate(t, MINT, 'TEST');
  assert.equal(d.split(' · ').length, orders.length, 'every armed order is named in the description');
  console.log('ok  the description names exactly what gets armed');
}

{
  // Sell-only templates never produce a buy: a template must not be able to
  // spend money on its own.
  for (const t of BUILT_IN_TEMPLATES) {
    for (const o of ordersForTemplate(t, MINT, 'TEST')) {
      assert.ok(!o.kind.includes('buy'), `${t.name} arms no buy`);
    }
  }
  console.log('ok  no template can ever arm a buy');
}
console.log('ordertemplates: all tests passed');
