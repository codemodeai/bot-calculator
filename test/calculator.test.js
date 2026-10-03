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

test('serviceType groups services by what they deliver', () => {
  const t = name => C.serviceType({ name, category: '' });
  assert.equal(t('YouTube Comment Likes [ Max 100K ]'), 'Comment Likes');
  assert.equal(t('Telegram Premium Members + Views [ 3 Days ]'), 'Members');
  assert.equal(t('YouTube Likes + Views From Google Search'), 'Likes');
  assert.equal(t('Youtube Subscribers [ Max 50K ]'), 'Subscribers');
  assert.equal(t('IG Reel Views + Reach'), 'Views');
});

test('speedPerHour reads speed and ignores start times and refill days', () => {
  const sp = name => C.speedPerHour({ name, category: '' });
  assert.equal(sp('Likes | 30 Days ♻️ | Speed: 300K/Day 🚀'), 12500);
  assert.equal(sp('IG Views [ All Links ] [ 1M / hour ]'), 1e6);
  assert.equal(sp('Speed: 1K/Hours'), 1000);
  assert.equal(sp('Speed: 500+/Day'), 500 / 24);
  assert.equal(sp('Video Views | All Link | Day 1M 🚀 - Fastest'), 1e6 / 24);
  assert.equal(sp('Speed: 2M/Day 🚀 𝐔𝐋𝐓𝐑𝐀 𝐅𝐀𝐒𝐓'), 2e6 / 24);
  assert.equal(sp('IG Views [ 0-1 hrs ]'), null);
  assert.equal(sp('Premium Members [ 30 Days Premium ]'), null);
});

test('startHours and refillInfo', () => {
  assert.equal(C.startHours({ name: 'Start Time: 24-48 Hours' }), 48);
  assert.equal(C.startHours({ name: 'Start: 0-1 Min' }), 1 / 60);
  assert.equal(C.startHours({ name: 'Instant Start' }), 0);
  assert.equal(C.refillInfo({ name: 'x | No Refill ⚠️' }).days, 0);
  assert.equal(C.refillInfo({ name: 'x | Lifetime ♻️' }).label, 'Lifetime refill');
  assert.equal(C.refillInfo({ name: 'x | 30 Days ♻️' }).label, '30-day refill');
});

test('pickOptions returns cheap / smart / fast / best without duplicates', () => {
  const mk = (id, rate, name, min = 10, max = 100000) => C.normaliseService({ id, name, rate, min, max, category: 'X' });
  const g = [
    mk(1, 10, 'Likes | No Refill | Speed: 1K/Day'),
    mk(2, 12, 'Likes | Lifetime ♻️ | Speed: 1K/Day'),
    mk(3, 30, 'Likes | No Refill | Speed: 100K/Day'),
    mk(4, 80, 'Likes | HQ | Non Drop | Lifetime ♻️ | Speed: 1K/Day')
  ];
  const opts = C.pickOptions(g, 5000);
  assert.deepEqual(opts.map(o => o.key + ':' + o.service.id), ['cheap:1', 'smart:2', 'fast:3', 'best:4']);
  // identical variants collapse to one card
  const same = [mk(5, 360, 'Comments [ UK ]'), mk(6, 360, 'Comments [ USA ]')];
  assert.deepEqual(C.pickOptions(same, 100).map(o => o.key), ['cheap']);
  // quantity outside every range still shows the cheapest, flagged
  const big = C.pickOptions(g, 1e7);
  assert.equal(big[0].fits, false);
});
