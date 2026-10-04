const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');
const shop = require('../lib/shop');
const services = require('../data/services.json').services;

const LIVE = {
  smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', keyId: 'rzp_test_abc', keySecret: 'secret123',
  webhookSecret: 'whsec', markup: 50, storeName: 'Test', support: ''
};
const DEMO = Object.assign({}, LIVE, { keyId: '', keySecret: '' });

// Fake Razorpay + panel behind global.fetch.
function fakeBackend() {
  const db = { orders: {}, payments: {}, panelAdds: [], n: 0 };
  global.fetch = async (url, init) => {
    const body = init && init.body;
    const reply = (status, data) => ({ status, text: async () => JSON.stringify(data) });
    if (url.startsWith(LIVE.smmUrl)) {
      const p = Object.fromEntries(new URLSearchParams(body));
      assert.equal(p.key, 'panel-key');
      if (p.action === 'services') return reply(200, services);
      if (p.action === 'add') { db.panelAdds.push(p); return reply(200, { order: 9000 + db.panelAdds.length }); }
      if (p.action === 'status') return reply(200, { status: 'In progress', start_count: '120', remains: '300', charge: '1.2' });
    }
    const m = url.match(/^https:\/\/api\.razorpay\.com\/v1(\/.*)$/);
    assert.ok(m, 'unexpected URL ' + url);
    const path = m[1], method = init.method, data = body ? JSON.parse(body) : null;
    if (method === 'POST' && path === '/orders') {
      const id = 'order_' + (++db.n);
      db.orders[id] = Object.assign({ id, status: 'created' }, data);
      return reply(200, db.orders[id]);
    }
    let r;
    if ((r = path.match(/^\/orders\/(\w+)$/))) return reply(200, db.orders[r[1]]);
    if ((r = path.match(/^\/payments\/(\w+)\/capture$/))) { db.payments[r[1]].status = 'captured'; return reply(200, db.payments[r[1]]); }
    if ((r = path.match(/^\/payments\/(\w+)$/))) {
      if (method === 'PATCH') db.payments[r[1]].notes = data.notes;
      return reply(200, db.payments[r[1]]);
    }
    return reply(404, { error: { description: 'not found' } });
  };
  db.pay = (orderId, status) => {
    const id = 'pay_' + Math.random().toString(36).slice(2, 14);
    db.payments[id] = { id, order_id: orderId, amount: db.orders[orderId].amount, currency: 'INR', status: status || 'captured', notes: [], created_at: 1 };
    return id;
  };
  return db;
}

test('retailRate and chargeAmount round in the store’s favour', () => {
  assert.equal(C.retailRate(2, 50), 3);
  assert.equal(C.chargeAmount(3, 1000), 3);
  assert.equal(C.chargeAmount(0.57, 1000), 1);          // ₹1 minimum
  assert.equal(C.chargeAmount(12.345, 1000), 12.35);    // rounded up to the paisa
  assert.equal(C.chargeAmount(1.1, 3000), 3.3);         // no float drift upwards
});

test('cleanLink accepts links and usernames, rejects junk', () => {
  assert.equal(shop.cleanLink(' https://www.instagram.com/p/abc/ '), 'https://www.instagram.com/p/abc/');
  assert.equal(shop.cleanLink('@my.name_1'), 'my.name_1');
  assert.equal(shop.cleanLink('instagram.com/p/abc'), 'https://instagram.com/p/abc');
  assert.throws(() => shop.cleanLink(''), /Enter/);
  assert.throws(() => shop.cleanLink('hello world'), /spaces/);
  assert.throws(() => shop.cleanLink('<script>'), /full link/);
});

test('mode is live only with Razorpay and panel keys', () => {
  assert.equal(shop.mode(LIVE), 'live');
  assert.equal(shop.mode(DEMO), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { smmKey: '' })), 'demo');
});

test('catalogue hides cost prices and custom-comment services', async () => {
  shop._resetCache();
  const cat = await shop.catalogue(Object.assign({}, DEMO, { smmKey: '' }));
  const svc33 = cat.services.find((s) => s.id === '33');
  assert.equal(svc33.rate, 3);                           // 2.00 cost + 50%
  assert.ok(!cat.services.some((s) => /custom/i.test(s.name)));
  assert.ok(cat.services.every((s) => s.platform !== 'Other'));
});

test('demo checkout never places a panel order', async () => {
  shop._resetCache();
  const db = fakeBackend();
  const o = await shop.createOrder({ serviceId: '33', quantity: 1000, link: 'https://instagram.com/p/x' }, DEMO);
  assert.equal(o.demo, true);
  assert.equal(o.amount, 300);
  const v = await shop.verifyAndFulfil({ demo: true }, DEMO);
  assert.equal(v.demo, true);
  assert.equal(db.panelAdds.length, 0);
  await assert.rejects(shop.verifyAndFulfil({ demo: true }, LIVE), /Demo payments are off/);
});

test('server rejects out-of-range quantities and unknown services', async () => {
  shop._resetCache();
  fakeBackend();
  await assert.rejects(shop.createOrder({ serviceId: '33', quantity: 10, link: 'x_y' }, LIVE), /Minimum order is 100/);
  await assert.rejects(shop.createOrder({ serviceId: 'nope', quantity: 1000, link: 'x_y' }, LIVE), /isn’t available/);
});

test('live flow: order -> signed payment -> one panel order -> status', async () => {
  shop._resetCache();
  const db = fakeBackend();
  const o = await shop.createOrder({ serviceId: '33', quantity: 1000, link: 'https://instagram.com/p/x', price: 0.01 }, LIVE);
  assert.equal(o.amount, 300, 'price comes from the server, not the request');
  assert.equal(db.orders[o.orderId].notes.service, '33');

  const payId = db.pay(o.orderId, 'authorized');
  const sig = shop.hmac(LIVE.keySecret, o.orderId + '|' + payId);
  await assert.rejects(shop.verifyAndFulfil({ razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: 'bad' }, LIVE), /signature/);

  const r = await shop.verifyAndFulfil({ razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: sig }, LIVE);
  assert.equal(r.smmOrder, '9001');
  assert.equal(r.trackingId, payId);
  assert.deepEqual(db.panelAdds.map((a) => [a.action, a.service, a.link, a.quantity]), [['add', '33', 'https://instagram.com/p/x', '1000']]);

  const again = await shop.fulfil(payId, LIVE);           // webhook / retry
  assert.equal(again.already, true);
  assert.equal(db.panelAdds.length, 1, 'never orders twice');

  const st = await shop.orderStatus(payId, LIVE);
  assert.equal(st.status, 'In progress');
  assert.equal(st.remains, 300);
  assert.equal(st.quantity, 1000);
});

test('webhook signature check', () => {
  const body = '{"event":"payment.captured"}';
  assert.ok(shop.verifyWebhookSignature(body, shop.hmac('whsec', body), 'whsec'));
  assert.ok(!shop.verifyWebhookSignature(body, shop.hmac('other', body), 'whsec'));
  assert.ok(!shop.verifyWebhookSignature(body, 'x', ''));
});
