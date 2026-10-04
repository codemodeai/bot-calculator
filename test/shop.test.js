const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const upi = require('../lib/upi');
const services = require('../data/services.json').services;

const LIVE = {
  smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', markup: 50, fx: 0, storeName: 'Test', support: '',
  upiId: 'store@okhdfcbank', upiName: 'Test Store', gmail: 'alerts@gmail.com', gmailPass: 'abcd efgh ijkl mnop',
  alertSenders: '', qrMinutes: 10,
  supabaseUrl: 'https://db.test', supabaseAnon: 'anon-key', supabaseService: 'service-key'
};
const DEMO = Object.assign({}, LIVE, { gmailPass: '' });
const USER = { id: 'user-1', email: 'a@x.com' };

/*
 * Fake SMM panel and Supabase behind global.fetch.
 * The Supabase RPCs mirror supabase/migrations/001_wallet.sql and 003_upi.sql (that SQL is tested separately
 * against Postgres).
 */
function fakeBackend() {
  const db = {
    panelAdds: [], wallets: {}, recharges: [], orders: [], ledger: [], alerts: [], panelReply: null,
    sync: { last_run: 0, last_uid: 0, uid_validity: 0, last_ok: null, last_error: null }, syncCalls: 0
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
    assert.ok(url.startsWith(LIVE.supabaseUrl), 'unexpected URL ' + url);
    return supabase(url.slice(LIVE.supabaseUrl.length), init);
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
    if (p === '/rest/v1/recharges') {
      const st = url.searchParams.get('status');
      return reply(200, db.recharges.filter((r) => r.user_id === eq('user_id') &&
        (!url.searchParams.get('id') || String(r.id) === eq('id')) && (!st || 'eq.' + r.status === st) &&
        (!url.searchParams.get('expires_at') || Date.parse(r.expires_at) > Date.parse(url.searchParams.get('expires_at').replace(/^gt\./, '')))));
    }
    if (p === '/rest/v1/upi_sync') return reply(200, [db.sync]);
    if (p === '/rest/v1/orders') return reply(200, db.orders.filter((o) => o.user_id === eq('user_id') && (!url.searchParams.get('id') || String(o.id) === eq('id'))));
    const fn = p.replace('/rest/v1/rpc/', '');
    const credit = (user, delta, kind) => { db.wallets[user] = C.round((db.wallets[user] || 0) + delta, 4); db.ledger.push({ user, delta, kind }); return db.wallets[user]; };
    // --- UPI (003_upi.sql), simplified
    const creditUpi = (r, a, how) => {
      if (r.status === 'paid' || a.recharge_id) return null;
      a.recharge_id = r.id;
      Object.assign(r, { status: 'paid', credited: Number(a.amount), utr: a.utr, bank: a.bank, matched_by: how });
      return credit(r.user_id, Number(a.amount), 'recharge');
    };
    const inWindow = (r, a, graceMs) => Date.parse(a.received_at) >= Date.parse(r.created_at) - 120e3 && Date.parse(a.received_at) <= Date.parse(r.expires_at) + graceMs;
    if (fn === 'create_upi_recharge') {
      const open = db.recharges.find((r) => r.user_id === data.p_user && r.status === 'pending' && r.amount === data.p_amount && Date.parse(r.expires_at) > Date.now() + 120e3);
      if (open) return reply(200, [open]);
      if (db.recharges.some((r) => r.ref === data.p_ref)) return reply(409, { message: 'duplicate key value violates unique constraint "recharges_ref_key"' });
      const taken = new Set(db.recharges.filter((r) => r.status === 'pending').map((r) => Number(r.expected_amount).toFixed(2)));
      let paise = 1 + Math.floor(Math.random() * 99);
      while (taken.has((data.p_amount + paise / 100).toFixed(2))) paise = paise % 99 + 1;
      const now = Date.now();
      const r = { id: db.recharges.length + 1, user_id: data.p_user, amount: data.p_amount, expected_amount: (data.p_amount + paise / 100).toFixed(2), ref: data.p_ref,
        status: 'pending', created_at: new Date(now).toISOString(), expires_at: new Date(now + data.p_minutes * 60e3).toISOString(), utr_tries: 0 };
      db.recharges.push(r);
      return reply(200, [r]);
    }
    if (fn === 'claim_upi_sync') {
      if (Date.now() - db.sync.last_run < data.p_min_seconds * 1000) return reply(200, []);
      db.sync.last_run = Date.now(); db.syncCalls++;
      return reply(200, [{ last_uid: db.sync.last_uid, uid_validity: db.sync.uid_validity }]);
    }
    if (fn === 'finish_upi_sync') {
      if (data.p_last_uid != null) { db.sync.last_uid = data.p_last_uid; db.sync.uid_validity = data.p_uid_validity; }
      db.sync.last_error = data.p_error; if (!data.p_error) db.sync.last_ok = new Date().toISOString();
      return reply(204);
    }
    if (fn === 'ingest_upi_alerts') {
      data.p_alerts.forEach((a) => { if (!db.alerts.some((x) => x.utr === a.utr)) db.alerts.push(Object.assign({ recharge_id: null }, a)); });
      let n = 0;
      db.alerts.filter((a) => !a.recharge_id).forEach((a) => {
        let r = a.ref && db.recharges.find((x) => x.status === 'pending' && x.ref === a.ref && inWindow(x, a, 30 * 60e3));
        let how = 'ref';
        if (!r) {
          const hits = db.recharges.filter((x) => x.status === 'pending' && Number(x.expected_amount) === Number(a.amount) && inWindow(x, a, 30 * 60e3));
          r = hits.length === 1 ? hits[0] : null; how = 'amount';
        }
        if (r && creditUpi(r, a, how) != null) n++;
      });
      return reply(200, n);
    }
    if (fn === 'claim_upi_utr') {
      const r = db.recharges.find((x) => x.id === data.p_recharge && x.user_id === data.p_user);
      if (!r) return reply(400, { message: 'RECHARGE_NOT_FOUND' });
      if (r.status === 'paid') return reply(200, 'paid');
      if (r.utr_tries >= 5) return reply(400, { message: 'TOO_MANY_TRIES' });
      r.utr_tries++;
      const a = db.alerts.find((x) => x.utr === data.p_utr);
      if (!a || !inWindow(r, a, 48 * 3600e3)) return reply(200, 'not_found');
      if (a.recharge_id) return reply(200, 'used');
      creditUpi(r, a, 'utr');
      return reply(200, 'paid');
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

test('mode is live only with panel, UPI, Gmail and Supabase keys', () => {
  assert.equal(shop.mode(LIVE), 'live');
  assert.equal(shop.mode(DEMO), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { smmKey: '' })), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { supabaseService: '' })), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { upiId: '' })), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { upiId: 'not a upi id' })), 'demo');
  assert.equal(shop.mode(Object.assign({}, LIVE, { gmail: '' })), 'demo');
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
  assert.equal(st.upi.payTo, 'store@okhdfcbank');
  assert.equal(st.keys.SUPABASE_SERVICE_ROLE_KEY, true);
  assert.equal(st.keys.GMAIL_APP_PASSWORD, true);
  assert.ok(!JSON.stringify(st).includes('abcd efgh'), 'never shows the Gmail app password');
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
  assert.deepEqual(await wallet.currentUser(req('good-token'), LIVE), Object.assign({ verified: false }, USER));
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


// ---------- UPI recharges ----------

// The inbox reader is replaced by a list of alerts "in Gmail"; everything else (matching, crediting) runs.
function fakeInbox(alerts, opts) {
  const calls = [];
  upi.readInbox = async (cfg, state) => {
    calls.push(state);
    if (opts && opts.fail) throw Object.assign(new Error('Command failed'), { authenticationFailed: true });
    const list = alerts.slice();
    alerts.length = 0;
    return { alerts: list, scanned: list.length, fromBanks: list.length, rejected: 0, lastUid: (state.last_uid || 0) + list.length, uidValidity: 7 };
  };
  return calls;
}
const realReadInbox = upi.readInbox;
test.afterEach(() => { upi.readInbox = realReadInbox; });

test('recharge: a UPI QR for a unique amount, credited when the bank alert arrives', async () => {
  const db = fakeBackend();
  const inbox = [];
  const reads = fakeInbox(inbox);
  await assert.rejects(wallet.createRecharge(USER, { amount: 0.5 }, LIVE), /minimum recharge is ₹1/);
  await assert.rejects(wallet.createRecharge(USER, { amount: 60000 }, LIVE), /maximum recharge/);

  const c = await wallet.createRecharge(USER, { amount: 100 }, LIVE);
  assert.ok(c.expectedAmount > 100 && c.expectedAmount < 101, 'rupees + 1..99 paise');
  assert.equal(c.link, 'upi://pay?pa=store@okhdfcbank&pn=Test%20Store&am=' + c.expectedAmount.toFixed(2) + '&cu=INR&tn=' + c.ref);
  assert.match(c.qr, /^<svg/);
  assert.equal(c.payTo, 'store@okhdfcbank');
  assert.equal((await wallet.createRecharge(USER, { amount: 100 }, LIVE)).id, c.id, 'reopening reuses the same QR');

  assert.equal((await wallet.rechargeStatus(USER, c.id, LIVE)).status, 'pending');
  assert.equal(reads.length, 1, 'the inbox was checked');
  await assert.rejects(wallet.rechargeStatus({ id: 'someone-else' }, c.id, LIVE), /not found/);

  // someone pays the base amount without the paise: not this recharge
  inbox.push({ utr: '427700000001', amount: '100.00', bank: 'HDFC Bank', payer: 'x@ybl', ref: '', received_at: new Date().toISOString() });
  db.sync.last_run = 0;
  assert.equal((await wallet.rechargeStatus(USER, c.id, LIVE)).status, 'pending');

  inbox.push({ utr: '427700000002', amount: c.expectedAmount.toFixed(2), bank: 'HDFC Bank', payer: 'john@okaxis', ref: '', received_at: new Date().toISOString() });
  db.sync.last_run = 0;
  const s = await wallet.rechargeStatus(USER, c.id, LIVE);
  assert.equal(s.status, 'paid');
  assert.equal(s.credited, c.expectedAmount, 'the wallet gets exactly what was paid');
  assert.equal(s.utr, '427700000002');
  assert.equal(s.balance, c.expectedAmount);
  assert.equal(db.wallets[USER.id], c.expectedAmount);

  db.sync.last_run = 0;
  await wallet.rechargeStatus(USER, c.id, LIVE);
  assert.equal(db.wallets[USER.id], c.expectedAmount, 'never credited twice');
  const w = await wallet.wallet(USER, LIVE);
  assert.deepEqual(w.recharges.map((r) => [r.amount, r.utr]), [[c.expectedAmount, '427700000002']]);
});

test('recharge: Gmail is checked at most every few seconds however many customers wait', async () => {
  const db = fakeBackend();
  const reads = fakeInbox([]);
  const c = await wallet.createRecharge(USER, { amount: 50 }, LIVE);
  await Promise.all([1, 2, 3, 4, 5].map(() => wallet.rechargeStatus(USER, c.id, LIVE)));
  assert.equal(reads.length, 1);
  assert.equal(db.syncCalls, 1);
});

test('recharge: "I’ve paid" with the UTR credits only a genuine, unused bank alert', async () => {
  const db = fakeBackend();
  const inbox = [];
  fakeInbox(inbox);
  const c = await wallet.createRecharge(USER, { amount: 20 }, LIVE);
  await assert.rejects(wallet.claimUtr(USER, c.id, '1234', LIVE), /12-digit UTR/);
  await assert.rejects(wallet.claimUtr(USER, c.id, '427700000009', LIVE), (e) => { assert.equal(e.status, 404); assert.match(e.message, /haven’t received/); return true; });

  // the customer changed the amount in their app to ₹20, so the unique amount didn't match; the UTR does
  inbox.push({ utr: '427700000010', amount: '20.00', bank: 'SBI', payer: '', ref: '', received_at: new Date().toISOString() });
  db.sync.last_run = 0;
  const s = await wallet.claimUtr(USER, c.id, '4277 0000 0010', LIVE);
  assert.equal(s.status, 'paid');
  assert.equal(s.credited, 20);
  assert.equal(db.wallets[USER.id], 20);

  const c2 = await wallet.createRecharge(USER, { amount: 30 }, LIVE);
  await assert.rejects(wallet.claimUtr(USER, c2.id, '427700000010', LIVE), /already been used/);
  await assert.rejects(wallet.claimUtr({ id: 'someone-else' }, c2.id, '427700000010', LIVE), /not found/);
  // five tries per payment: the used UTR above was the first
  for (let i = 0; i < 4; i++) await assert.rejects(wallet.claimUtr(USER, c2.id, '427700000099', LIVE), /haven’t received/);
  await assert.rejects(wallet.claimUtr(USER, c2.id, '427700000099', LIVE), /Too many tries/);
  assert.equal(db.wallets[USER.id], 20);
});

test('recharge: a payment made while the page was closed is credited on the next visit', async () => {
  const db = fakeBackend();
  const inbox = [];
  fakeInbox(inbox);
  const c = await wallet.createRecharge(USER, { amount: 10 }, LIVE);
  inbox.push({ utr: '427700000020', amount: c.expectedAmount.toFixed(2), bank: 'Axis Bank', payer: '', ref: c.ref, received_at: new Date().toISOString() });
  db.sync.last_run = 0;
  const w = await wallet.wallet(USER, LIVE);
  assert.equal(w.balance, c.expectedAmount);
});

test('inbox problems show on /api/status without secrets, and never break the checkout', async () => {
  const db = fakeBackend();
  fakeInbox([], { fail: true });
  const c = await wallet.createRecharge(USER, { amount: 10 }, LIVE);
  assert.equal((await wallet.rechargeStatus(USER, c.id, LIVE)).status, 'pending');
  assert.match(db.sync.last_error, /App Password/);
  const st = await wallet.inboxStatus(LIVE);
  assert.equal(st.gmail, 'a•••s@gmail.com');
  assert.match(st.lastError, /App Password/);
  assert.ok(!JSON.stringify(st).includes('abcd'));
});
