const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');

const svc = C.normaliseService({ service: 101, name: 'Instagram Followers | Refill', category: 'Instagram Followers', rate: '1.20', min: '50', max: '100000', dripfeed: true });

test('parseMoney handles symbols and separators', () => {
  assert.deepEqual(C.parseMoney('$0.4500'), { value: 0.45, currency: 'USD' });
  assert.deepEqual(C.parseMoney('₹ 1,234.50'), { value: 1234.5, currency: 'INR' });
  assert.deepEqual(C.parseMoney('0,45 €'), { value: 0.45, currency: 'EUR' });
  assert.deepEqual(C.parseMoney('1.234,50'), { value: 1234.5, currency: null });
  assert.equal(C.parseMoney('1,000').value, 1000);
});

test('quote = rate / 1000 * quantity', () => {
  const q = C.quote(svc, { quantity: 2500 });
  assert.equal(q.price, 3);
  assert.equal(q.cost, 3);
  assert.ok(q.valid);
});

test('quote applies drip-feed runs, markup and discount', () => {
  const q = C.quote(svc, { quantity: 1000, runs: 5, markup: 50, discount: 10 });
  assert.equal(q.totalQuantity, 5000);
  assert.equal(q.cost, 6);
  assert.equal(q.price, 8.1);
  assert.equal(q.profit, 2.1);
});

test('quote enforces min and max', () => {
  assert.deepEqual(C.quote(svc, { quantity: 10 }).errors, ['Minimum order is 50.']);
  assert.deepEqual(C.quote(svc, { quantity: 200000 }).errors, ['Maximum order is 100000.']);
  assert.equal(C.quote(svc, { quantity: 0 }).valid, false);
});

test('quantityForBudget rounds down and respects limits', () => {
  assert.deepEqual(C.quantityForBudget(svc, 10), { quantity: 8333, affordable: true });
  assert.deepEqual(C.quantityForBudget(svc, 0.01), { quantity: 8, affordable: false });
  assert.deepEqual(C.quantityForBudget(svc, 1e6), { quantity: 100000, affordable: true });
});

test('parseJson reads Perfect Panel API output', () => {
  const list = C.parseJson(JSON.stringify([
    { service: 1, name: 'Followers', type: 'Default', category: 'First Category', rate: '0.90', min: '50', max: '10000', refill: true, cancel: true },
    { service: 2, name: 'Comments', type: 'Custom Comments', category: 'Second Category', rate: '8', min: '10', max: '1500', refill: false, cancel: true }
  ]));
  assert.equal(list.length, 2);
  assert.equal(list[0].id, '1');
  assert.equal(list[0].rate, 0.9);
  assert.equal(list[0].refill, true);
  assert.equal(list[1].type, 'Custom Comments');
});

test('parseTable reads a table copied from a /services page', () => {
  const text = [
    'ID\tService\tRate per 1000\tMin order\tMax order\tAverage time\tDescription',
    'Instagram Followers',
    '1023\tInstagram Followers | Max 100K | 30 Days Refill\t$1.2000\t50\t100 000\t2 hours 5 minutes\tDetails',
    '1024\tInstagram Followers | HQ\t$2.80\t100\t50000\t6 hours',
    'TikTok Views',
    '2001\tTikTok Views | Fast\t$0.0100\t100\t50000000\t5 minutes'
  ].join('\n');
  const list = C.parseTable(text);
  assert.equal(list.length, 3);
  assert.equal(list[0].name, 'Instagram Followers | Max 100K | 30 Days Refill');
  assert.equal(list[0].category, 'Instagram Followers');
  assert.equal(list[0].max, 100000);
  assert.equal(list[0].currency, 'USD');
  assert.equal(list[2].category, 'TikTok Views');
  assert.equal(list[2].rate, 0.01);
});

test('parseAny detects CSV and round-trips toCsv', () => {
  const list = C.parseTable('Cat A\n1\tA, "quoted"\t$1\t10\t100');
  const back = C.parseAny(C.toCsv(list));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'A, "quoted"');
  assert.equal(back[0].category, 'Cat A');
  assert.equal(back[0].rate, 1);
});

test('platformOf detects platform', () => {
  assert.equal(C.platformOf({ category: 'TikTok Likes', name: '' }), 'TikTok');
  assert.equal(C.platformOf({ category: 'X / Twitter', name: '' }), 'Twitter');
  assert.equal(C.platformOf({ category: 'Misc', name: 'Website Traffic' }), 'Website');
});

test('platformOf understands short platform names', () => {
  assert.equal(C.platformOf({ category: 'IG Views', name: 'IG Views [ Cheap ]' }), 'Instagram');
  assert.equal(C.platformOf({ category: 'YT Likes', name: '' }), 'YouTube');
});
