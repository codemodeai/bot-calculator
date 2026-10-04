const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const services = require('../data/services.json').services;

const LIVE = {
  smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', keyId: 'rzp_test_abc', keySecret: 'secret123',
  webhookSecret: 'whsec', markup: 50, fx: 0, storeName: 'Test', support: '',
  supabaseUrl: 'https://db.test', supabaseAnon: 'anon-key', supabaseService: 'service-key'
};
const DEMO = Object.assign({}, LIVE, { keyId: '', keySecret: '' });
const USER = { id: 'user-1', email: 'a@x.com' };

/*
 * Fake Razorpay, SMM panel and Supabase behind global.fetch.
 * The Supabase RPCs mirror supabase/migrations/001_wallet.sql (that SQL is tested separately against Postgres).
 */
function fakeBackend() {
  const db = {
    rzOrders: {}, payments: {}, panelAdds: [], n: 0,
    wallets: {}, recharges: [], orders: [], ledger: [], panelReply: null
  };
  const reply = (status, data) => ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  global.fetch = async (url, init) => {
    init = init || {};
    const body = init.body;
    if (url.startsWith(LIVE.smmUrl)) {
      if (db.panelDown) throw new Error('network down');
      const p = Object.fromEntries(new URLSearchParams(body));
      assert.equal(p.key, 'panel-key');
      if (p.action === 'services') return reply(200, db.panelServices || services);
      if (p.action === 'balance') return reply(200, { balance: '100.00', currency: db.panelCurrency || 'INR' });
      if (p.action === 'add') {
        if (db.panelAddError) return reply(200, { error: db.panelAddError });
        if (db.panelAddTimeout) throw new Error('timeout');
        db.panelAdds.push(p);
        return reply(200, { order: 9000 + db.panelAdds.length });
      }
      if (p.action === 'status') return reply(200, { status: 'In progress', start_count: '120', remains: '300' });
    }
    if (url.startsWith(LIVE.supabaseUrl)) return supabase(url.slice(LIVE.supabaseUrl.length), init);
    const m = url.match(/^https:\/\/api\.razorpay\.com\/v1(\/.*)$/);
    assert.ok(m, 'unexpected URL ' + url);
    const path = m[1], method = init.method, data = body ? JSON.parse(body) : null;
    if (method === 'POST' && path === '/orders') {
      const id = 'order_' + (++db.n);
      db.rzOrders[id] = Object.assign({ id, status: 'created' }, data);
      return reply(200, db.rzOrders[id]);
    }
    let r;
    if ((r = path.match(/^\/payments\/(\w+)\/capture$/))) { db.payments[r[1]].status = 'captured'; return reply(200, db.payments[r[1]]); }
    if ((r = path.match(/^\/payments\/(\w+)$/))) return reply(200, db.payments[r[1]]);
    return reply(404, { error: { description: 'not found' } });
  };

  function supabase(path, init) {
    const url = new URL('https://x' + path);
    const p = url.pathname, method = init.method || 'GET';
    const data = init.body ? JSON.parse(init.body) : null;
    const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '');
    if (p === '/auth/v1/user') {
      return init.headers.Authorization === 'Bearer good-token' ? reply(200, USER) : reply(401, { msg: 'bad jwt' });
    }
    assert.equal(init.headers.apikey, 'service-key');
    if (p === '/rest/v1/wallets') return reply(200, db.wallets[eq('user_id')] != null ? [{ balance: String(db.wallets[eq('user_id')]) }] : []);
    if (p === '/rest/v1/recharges' && method === 'POST') { db.recharges.push(Object.assign({ status: 'created' }, data)); return reply(201); }
    if (p === '/rest/v1/recharges') return reply(200, db.recharges.filter((r) => r.razorpay_order_id === eq('razorpay_order_id') || (r.user_id === eq('user_id') && r.status === 'paid')));
    if (p === '/rest/v1/orders') return reply(200, db.orders.filter((o) => o.user_id === eq('user_id') && (!url.searchParams.get('id') || String(o.id) === eq('id'))));
    const fn = p.replace('/rest/v1/rpc/', '');
    const credit = (user, delta, kind) => { db.wallets[user] = C.round((db.wallets[user] || 0) + delta, 4); db.ledger.push({ user, delta, kind }); return db.wallets[user]; };
    if (fn === 'credit_recharge') {
      const r = db.recharges.find((x) => x.razorpay_order_id === data.p_razorpay_order_id);
      if (!r) return reply(400, { message: 'RECHARGE_NOT_FOUND' });
      if (r.status === 'paid') return reply(200, db.wallets[r.user_id]);
      r.status = 'paid'; r.razorpay_payment_id = data.p_payment_id;
      return reply(200, credit(r.user_id, r.amount, 'recharge'));
    }
    if (fn === 'place_order') {
      if (!((db.wallets[data.p_user] || 0) >= data.p_charge)) return reply(400, { message: 'INSUFFICIENT_FUNDS' });
      const bal = credit(data.p_user, -data.p_charge, 'order');
      const o = { id: db.orders.length + 1, user_id: data.p_user, service_id: data.p_service_id, title: data.p_title, link: data.p_link, quantity: data.p_quantity, charge: data.p_charge, cost: data.p_cost, status: 'placing' };
      db.orders.push(o);
      return reply(200, [{ order_id: o.id, balance: bal }]);
    }
    if (fn === 'finish_order') { const o = db.orders[data.p_order - 1]; o.status = 'placed'; o.smm_order = data.p_smm_order; return reply(204); }
    if (fn === 'fail_order') {
      const o = db.orders[data.p_order - 1];
      if (o.status !== 'placing') return reply(200, null);
      o.error = data.p_error;
      if (!data.p_refund) { o.status = 'checking'; return reply(200, null); }
      o.status = 'refunded';
      return reply(200, credit(o.user_id, o.charge, 'refund'));
    }
    return reply(404, { message: 'no route ' + p });
  }

  // A customer paying a Razorpay order (status as Razorpay would report it).
  db.pay = (orderId, status) => {
    const id = 'pay_' + Math.random().toString(36).slice(2, 14);
    db.payments[id] = { id, order_id: orderId, amount: db.rzOrders[orderId].amount, currency: 'INR', status: status || 'captured', notes: db.rzOrders[orderId].notes, created_at: 1 };
    return id;
  };
  db.sign = (orderId, payId) => shop.hmac(LIVE.keySecret, orderId + '|' + payId);
  return db;
}

const req = (token) => ({ headers: token ? { authorization: 'Bearer ' + token } : {} });

// ---------- prices ----------

test('exactCharge has no ₹1 minimum and rounds up to 4 decimals', () => {
  assert.equal(C.exactCharge(0.24, 1000), 0.24);
  assert.equal(C.exactCharge(0.24, 100), 0.024);
  assert.equal(C.exactCharge(0.36, 2777), 0.9998);
  assert.equal(C.exactCharge(1.1, 3000), 3.3);        // no float drift upwards
  assert.equal(C.exactCharge(0.00001, 1), 0.0001);    // tiny amounts still cost something
  assert.equal(C.formatPrice(0.024, 'INR'), '₹0.024');
  assert.equal(C.formatPrice(11.616, 'INR'), '₹11.616');
  assert.equal(C.formatPrice(12.5, 'INR'), '₹12.50');
  assert.equal(C.retailRate(2, 50), 3);
});

test('cleanLink accepts links and usernames, rejects junk', () => {
  assert.equal(shop.cleanLink(' https://www.instagram.com/p/abc/ '), 'https://www.instagram.com/p/abc/');
  assert.equal(shop.cleanLink('@my.name_1'), 'my.name_1');
  assert.equal(shop.cleanLink('instagram.com/p/abc'), 'https://instagram.com/p/abc');
  assert.throws(() => shop.cleanLink(''), /Enter/);
  assert.throws(() => shop.cleanLink('hello world'), /spaces/);
  assert.throws(() => shop.cleanLink('<script>'), /full link/);
});

test('mode is live only with panel, Razorpay and Supabase keys', () => {
  assert.equal(shop.mode(LIVE), 'live');
  assert.equal(shop.mode(DEMO), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { smmKey: '' })), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { supabaseService: '' })), 'demo');
});

test('catalogue hides cost prices and custom-comment services', async () => {
  shop._resetCache();
  const cat = await shop.catalogue(Object.assign({}, DEMO, { smmKey: '' }));
  assert.equal(cat.source, 'sample');
  assert.equal(cat.services.find((s) => s.id === '33').rate, 3);   // 2.00 cost + 50%
  assert.ok(!cat.services.some((s) => /custom/i.test(s.name)));
  assert.ok(cat.services.every((s) => s.platform !== 'Other'));
});

test('priceOrder charges the exact price from the server, not the request', async () => {
  shop._resetCache();
  fakeBackend();
  const p = await shop.priceOrder({ serviceId: '33', quantity: 100, link: 'https://instagram.com/p/x', price: 0.0001 }, LIVE);
  assert.equal(p.charge, 0.3);                 // ₹3.00 per 1000 (2.00 + 50%) × 100
  assert.equal(p.cost, 0.2);
  await assert.rejects(shop.priceOrder({ serviceId: '33', quantity: 10, link: 'x_y' }, LIVE), /Minimum order is 100/);
  await assert.rejects(shop.priceOrder({ serviceId: 'nope', quantity: 1000, link: 'x_y' }, LIVE), /isn’t available/);
});

test('with a panel key, prices come live from the panel', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.panelServices = [{ service: 33, name: 'IG Views', category: 'IG Views', rate: '9.00', min: '100', max: '1000' }];
  const cat = await shop.catalogue(LIVE);
  assert.equal(cat.source, 'live');
  assert.deepEqual(cat.services.map((s) => [s.id, s.rate]), [['33', 13.5]]);
});

test('panel errors are reported instead of falling back to sample prices', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.panelServices = { error: 'Incorrect API Key' };
  await assert.rejects(shop.catalogue(LIVE), /Incorrect API Key/);
  const st = await shop.status(LIVE);
  assert.equal(st.panel.ok, false);
  assert.match(st.panel.error, /Incorrect API Key/);
  assert.equal(st.razorpay, 'test keys');
  assert.equal(st.keys.SUPABASE_SERVICE_ROLE_KEY, true);
});

test('a short panel outage reuses the last live prices', async () => {
  shop._resetCache();
  const db = fakeBackend();
  await shop.catalogue(LIVE);
  db.panelDown = true;
  const realNow = Date.now;
  Date.now = () => realNow() + 6 * 60 * 1000;
  try {
    const cat = await shop.catalogue(LIVE);
    assert.equal(cat.stale, true);
  } finally { Date.now = realNow; }
});

test('non-INR panel accounts need an exchange rate', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.panelCurrency = 'USD';
  db.panelServices = [{ service: 1, name: 'Instagram Likes', category: 'Instagram Likes', rate: '0.10', min: '10', max: '1000' }];
  await assert.rejects(shop.catalogue(LIVE), /PANEL_TO_INR_RATE/);
  shop._resetCache();
  const cat = await shop.catalogue(Object.assign({}, LIVE, { fx: 84, markup: 0 }));
  assert.equal(cat.services[0].rate, 8.4);
});

// ---------- wallet ----------

test('wallet endpoints need a signed-in customer and a live setup', async () => {
  fakeBackend();
  await assert.rejects(wallet.currentUser(req(), LIVE), /sign in/);
  await assert.rejects(wallet.currentUser(req('stolen'), LIVE), /session expired/);
  await assert.rejects(wallet.currentUser(req('good-token'), DEMO), /isn’t connected/);
  assert.deepEqual(await wallet.currentUser(req('good-token'), LIVE), USER);
});

test('recharge: minimum ₹1, signed payment credits the wallet once', async () => {
  shop._resetCache();
  const db = fakeBackend();
  await assert.rejects(wallet.createRecharge(USER, { amount: 0.5 }, LIVE), /minimum recharge is ₹1/);
  const o = await wallet.createRecharge(USER, { amount: 1 }, LIVE);
  assert.equal(o.amount, 100);
  assert.equal(db.rzOrders[o.orderId].notes.user_id, USER.id);

  const payId = db.pay(o.orderId, 'authorized');
  await assert.rejects(wallet.verifyRecharge(USER, { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: 'bad' }, LIVE), /signature/);
  const body = { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: db.sign(o.orderId, payId) };
  assert.equal((await wallet.verifyRecharge(USER, body, LIVE)).balance, 1);
  assert.equal((await wallet.verifyRecharge(USER, body, LIVE)).balance, 1, 'same payment never credits twice');
  assert.equal((await wallet.creditPayment(payId, LIVE)).balance, 1, 'webhook after the page: still once');
  await assert.rejects(wallet.verifyRecharge({ id: 'someone-else' }, body, LIVE), /another account/);
});

test('orders take the exact price from the wallet and place one panel order', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.wallets[USER.id] = 1;
  // ₹3.00 per 1000 after markup: 100 views = ₹0.30, well under the old ₹1 minimum.
  const r = await wallet.placeOrder(USER, { serviceId: '33', quantity: 100, link: 'https://instagram.com/p/x' }, LIVE);
  assert.equal(r.charge, 0.3);
  assert.equal(r.balance, 0.7);
  assert.equal(r.smmOrder, '9001');
  assert.deepEqual(db.panelAdds.map((a) => [a.service, a.link, a.quantity]), [['33', 'https://instagram.com/p/x', '100']]);
  assert.equal(db.orders[0].status, 'placed');

  const st = await wallet.orderStatus(USER, r.orderId, LIVE);
  assert.equal(st.status, 'In progress');
  assert.equal(st.remains, 300);
  await assert.rejects(wallet.orderStatus({ id: 'someone-else' }, r.orderId, LIVE), /not found/);
});

test('not enough balance: nothing is charged or ordered', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.wallets[USER.id] = 0.1;
  await assert.rejects(wallet.placeOrder(USER, { serviceId: '33', quantity: 1000, link: 'https://instagram.com/p/x' }, LIVE), (e) => {
    assert.match(e.message, /Not enough balance/);
    assert.equal(e.status, 402);
    assert.equal(e.extra.needed, 2.9);
    return true;
  });
  assert.equal(db.wallets[USER.id], 0.1);
  assert.equal(db.panelAdds.length, 0);
});

test('panel refuses the order: the charge goes back to the wallet', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.wallets[USER.id] = 5;
  db.panelAddError = 'Not enough funds on balance';
  await assert.rejects(wallet.placeOrder(USER, { serviceId: '33', quantity: 100, link: 'https://instagram.com/p/x' }, LIVE), /₹0.30 is back in your wallet/);
  assert.equal(db.wallets[USER.id], 5);
  assert.equal(db.orders[0].status, 'refunded');
});

test('panel times out: the order is held for checking, not refunded blindly', async () => {
  shop._resetCache();
  const db = fakeBackend();
  db.wallets[USER.id] = 5;
  db.panelAddTimeout = true;
  await assert.rejects(wallet.placeOrder(USER, { serviceId: '33', quantity: 100, link: 'https://instagram.com/p/x' }, LIVE), /didn’t answer/);
  assert.equal(db.orders[0].status, 'checking');
  assert.equal(db.wallets[USER.id], 4.7);
});

test('webhook signature check', () => {
  const body = '{"event":"payment.captured"}';
  assert.ok(shop.verifyWebhookSignature(body, shop.hmac('whsec', body), 'whsec'));
  assert.ok(!shop.verifyWebhookSignature(body, shop.hmac('other', body), 'whsec'));
  assert.ok(!shop.verifyWebhookSignature(body, 'x', ''));
});

test('new sb_secret_ keys go only in the apikey header; legacy JWT keys also in Authorization', async () => {
  const seen = [];
  global.fetch = async (url, init) => { seen.push(init.headers); return { status: 200, text: async () => '[]' }; };
  await wallet.wallet(USER, Object.assign({}, LIVE, { supabaseService: 'sb_secret_abc' }));
  assert.ok(seen.every((h) => h.apikey === 'sb_secret_abc' && !h.Authorization));
  seen.length = 0;
  await wallet.wallet(USER, Object.assign({}, LIVE, { supabaseService: 'eyJhbGciOi.legacy' }));
  assert.ok(seen.every((h) => h.Authorization === 'Bearer eyJhbGciOi.legacy'));
});

test('80% markup rounds up to tidy prices: ₹0.16 cost -> ₹0.30 per 1000', async () => {
  assert.equal(C.niceRate(C.retailRate(0.16, 80)), 0.3);
  assert.equal(C.niceRate(C.retailRate(11.616, 80)), 21);
  assert.equal(C.niceRate(C.retailRate(90, 80)), 165);
  assert.equal(C.niceRate(0.3), 0.3, 'already tidy prices stay put');
  shop._resetCache();
  const db = fakeBackend();
  db.panelServices = [{ service: 931, name: 'Instagram Video Views', category: 'Instagram Views', rate: '0.16', min: '100', max: '1000000' }];
  const cfg = Object.assign({}, LIVE, { markup: 80, roundPrices: true });
  const cat = await shop.catalogue(cfg);
  assert.equal(cat.services[0].rate, 0.3);
  assert.equal((await shop.priceOrder({ serviceId: '931', quantity: 1000, link: 'https://instagram.com/p/x' }, cfg)).charge, 0.3);
});

test('recharge adds the Razorpay fee on top; the wallet gets the full amount', async () => {
  shop._resetCache();
  const db = fakeBackend();
  const cfg = Object.assign({}, LIVE, { feePercent: 2.36 });
  assert.equal(C.gatewayFee(100, 2.36), 2.36);
  assert.equal(C.gatewayFee(1, 2.36), 0.03);
  assert.equal(C.gatewayFee(100, 0), 0);
  const o = await wallet.createRecharge(USER, { amount: 100 }, cfg);
  assert.equal(o.amount, 10236, 'customer pays ₹102.36');
  assert.equal(o.fee, 2.36);
  const payId = db.pay(o.orderId);
  const r = await wallet.verifyRecharge(USER, { razorpay_order_id: o.orderId, razorpay_payment_id: payId, razorpay_signature: db.sign(o.orderId, payId) }, cfg);
  assert.equal(r.balance, 100, 'wallet gets ₹100');
  assert.equal(r.paid, 102.36);
});
