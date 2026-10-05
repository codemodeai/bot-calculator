const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../calculator');
const shop = require('../lib/shop');
const drip = require('../lib/drip');

const CFG = {
  smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', markup: 50, roundPrices: false, fx: 0, storeName: 'Test', support: '',
  upiId: 'store@okhdfcbank', upiName: 'Test', gmail: 'g@gmail.com', gmailPass: 'p', alertSenders: '', qrMinutes: 10,
  supabaseUrl: 'https://db.test', supabaseAnon: 'anon', supabaseService: 'service-key', adminEmails: []
};
const USER = { id: 'u1', email: 'c@x.com' };
const SERVICE = { service: 564, name: 'Instagram Views | Start: 0-1 Hours | Speed: 100K/Day', category: 'Instagram Views', rate: '0.20', min: '100', max: '1000000' };

/*
 * Fake panel + Supabase. The RPCs follow supabase/migrations/005_drip.sql (tested separately against Postgres).
 */
function fake() {
  const db = { wallet: 100, orders: [], parts: [], adds: [], panel: {}, addError: null, addThrows: false, statusOf: () => 'Completed', n: 9000 };
  const reply = (status, data) => ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  const due = (p) => p.status === 'scheduled' && Date.parse(p.scheduled_at) <= Date.now() &&
    db.orders.find((o) => o.id === p.order_id).drip_state === 'running' &&
    (p.seq === 1 || db.parts.some((x) => x.order_id === p.order_id && x.seq === p.seq - 1 && x.status === 'placed'));
  const refundUnsent = (oid, state, note) => {
    const o = db.orders.find((x) => x.id === oid);
    db.parts.filter((p) => p.order_id === oid && p.status === 'scheduled').forEach((p) => { p.status = 'canceled'; });
    const amt = C.round(db.parts.filter((p) => p.order_id === oid && (p.status === 'canceled' || p.status === 'failed')).reduce((a, p) => a + p.charge, 0) - o.refunded, 4);
    o.drip_state = state; o.refunded = C.round(o.refunded + Math.max(0, amt), 4); o.error = note;
    db.wallet = C.round(db.wallet + Math.max(0, amt), 4);
    return { refunded: Math.max(0, amt), balance: db.wallet };
  };
  global.fetch = async (url, init) => {
    init = init || {};
    if (url.startsWith(CFG.smmUrl)) {
      const p = Object.fromEntries(new URLSearchParams(init.body));
      if (p.action === 'services') return reply(200, [SERVICE]);
      if (p.action === 'balance') return reply(200, { balance: '50', currency: 'INR' });
      if (p.action === 'add') {
        if (db.addThrows) throw new Error('timeout');
        if (db.addError) return reply(200, { error: db.addError });
        db.adds.push(p); const id = String(++db.n); db.panel[id] = Number(p.quantity);
        return reply(200, { order: id });
      }
      if (p.action === 'status' && p.orders) return reply(200, Object.fromEntries(p.orders.split(',').map((id) => [id, { status: db.statusOf(id), remains: '0' }])));
      if (p.action === 'status') return reply(200, { status: db.statusOf(p.order), remains: '0' });
    }
    const u = new URL(url), path = u.pathname, data = init.body ? JSON.parse(init.body) : null;
    const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    if (path === '/rest/v1/wallets') return reply(200, [{ balance: String(db.wallet) }]);
    if (path === '/rest/v1/orders') return reply(200, db.orders.filter((o) => (!u.searchParams.get('id') || String(o.id) === eq('id')) && (!u.searchParams.get('user_id') || o.user_id === eq('user_id')) && (!u.searchParams.get('drip_state') || o.drip_state === eq('drip_state'))));
    if (path === '/rest/v1/order_parts') {
      const ids = (u.searchParams.get('order_id') || '').replace(/^(eq\.|in\.\()/, '').replace(/\)$/, '').split(',').map(Number);
      return reply(200, db.parts.filter((p) => ids.includes(p.order_id)).sort((a, b) => a.seq - b.seq));
    }
    const fn = path.replace('/rest/v1/rpc/', '');
    if (fn === 'place_drip_order') {
      if (db.wallet < data.p_charge) return reply(400, { message: 'INSUFFICIENT_FUNDS' });
      db.wallet = C.round(db.wallet - data.p_charge, 4);
      const o = { id: db.orders.length + 1, user_id: data.p_user, title: data.p_title, link: data.p_link, quantity: data.p_quantity, charge: data.p_charge, cost: data.p_cost, status: 'placed', drip: true, drip_state: 'running', parts: data.p_parts.length, interval_minutes: data.p_interval, refunded: 0, created_at: new Date().toISOString(), service_id: data.p_service_id };
      db.orders.push(o);
      data.p_parts.forEach((x, i) => db.parts.push({ id: db.parts.length + 1, order_id: o.id, seq: i + 1, quantity: x.quantity, charge: x.charge, cost: x.cost, status: 'scheduled', scheduled_at: x.at, attempts: 0, smm_order: null }));
      return reply(200, [{ order_id: o.id, balance: db.wallet }]);
    }
    if (fn === 'claim_due_parts') {
      const list = db.parts.filter((p) => due(p) && (!data.p_order || p.order_id === data.p_order)).slice(0, data.p_limit);
      return reply(200, list.map((p) => {
        p.status = 'placing'; p.attempts++;
        const o = db.orders.find((x) => x.id === p.order_id), prev = db.parts.find((x) => x.order_id === p.order_id && x.seq === p.seq - 1);
        return { part_id: p.id, order_id: p.order_id, seq: p.seq, quantity: p.quantity, attempts: p.attempts, service_id: o.service_id, link: o.link, prev_smm: prev ? prev.smm_order : null };
      }));
    }
    const part = data && data.p_part ? db.parts.find((x) => x.id === data.p_part) : null;
    if (fn === 'finish_part') {
      Object.assign(part, { status: 'placed', smm_order: data.p_smm_order });
      if (!db.parts.some((x) => x.order_id === part.order_id && ['scheduled', 'placing', 'checking'].includes(x.status))) db.orders.find((o) => o.id === part.order_id).drip_state = 'done';
      return reply(204);
    }
    if (fn === 'postpone_part') { Object.assign(part, { status: 'scheduled', scheduled_at: new Date(Date.now() + data.p_minutes * 60e3).toISOString(), error: data.p_note }); if (data.p_undo_attempt) part.attempts--; return reply(204); }
    if (fn === 'check_part') { part.status = 'checking'; return reply(204); }
    if (fn === 'fail_part') {
      if (part.attempts < 3) { Object.assign(part, { status: 'scheduled', scheduled_at: new Date(Date.now() + 15 * 60e3).toISOString(), error: data.p_error }); return reply(200, { stopped: false, retry: true }); }
      part.status = 'failed';
      return reply(200, Object.assign({ stopped: true }, refundUnsent(part.order_id, 'stopped', 'Stopped: ' + data.p_error)));
    }
    if (fn === 'cancel_drip') {
      const o = db.orders.find((x) => x.id === data.p_order && x.user_id === data.p_user);
      if (!o) return reply(400, { message: 'ORDER_NOT_FOUND' });
      if (o.drip_state !== 'running') return reply(400, { message: 'NOT_RUNNING' });
      return reply(200, refundUnsent(o.id, 'canceled', 'Canceled by customer'));
    }
    return reply(404, { message: 'no route ' + path });
  };
  db.makeDue = (oid) => db.parts.filter((p) => p.order_id === oid && p.status === 'scheduled').forEach((p) => { p.scheduled_at = new Date(Date.now() - 1000).toISOString(); });
  return db;
}

const ORDER = { serviceId: '564', quantity: 50000, link: 'https://www.instagram.com/reel/abc/' };

test('a gradual order costs +20%, is split into parts that add up, and sends part 1 at once', async () => {
  shop._resetCache();
  const db = fake();
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { parts: 7, intervalMinutes: 360 } }, ORDER), CFG);
  // ₹0.30 per 1000 (0.20 + 50%) × 50,000 = ₹15, +20% = ₹18
  assert.equal(r.charge, 18);
  assert.equal(db.wallet, 82);
  assert.equal(r.drip.parts, 7);
  const parts = db.parts.filter((p) => p.order_id === r.orderId);
  assert.equal(parts.reduce((a, p) => a + p.quantity, 0), 50000);
  assert.equal(C.round(parts.reduce((a, p) => a + p.charge, 0), 4), 18, 'part shares add up to the price');
  assert.ok(parts.every((p) => p.quantity >= 100));
  assert.ok(new Set(parts.map((p) => p.quantity)).size > 1, 'random, uneven parts');
  const gaps = parts.slice(1).map((p, i) => (Date.parse(p.scheduled_at) - Date.parse(parts[i].scheduled_at)) / 60e3);
  assert.ok(gaps.every((g) => Math.abs(g - 360) < 0.01), 'every 6 hours');
  assert.equal(db.adds.length, 1, 'part 1 was sent to the panel');
  assert.equal(db.adds[0].quantity, String(parts[0].quantity));
  assert.equal(parts[0].status, 'placed');
});

test('the gap can’t be shorter than the provider needs, and custom splits are checked', async () => {
  shop._resetCache();
  fake();
  await assert.rejects(drip.placeDripOrder(USER, Object.assign({ drip: { parts: 5, intervalMinutes: 30 } }, ORDER), CFG), /at least .* between them/);
  await assert.rejects(drip.placeDripOrder(USER, Object.assign({ drip: { parts: 1, intervalMinutes: 600 } }, ORDER), CFG), /2 to 30 parts/);
  await assert.rejects(drip.placeDripOrder(USER, Object.assign({ drip: { split: [20000, 20000], intervalMinutes: 600 } }, ORDER), CFG), /add up to 40,000/);
  await assert.rejects(drip.placeDripOrder(USER, Object.assign({ drip: { split: [50, 49950], intervalMinutes: 900 } }, ORDER), CFG), /at least 100/);
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 15000, 25000], intervalMinutes: 480 } }, ORDER), CFG);
  assert.equal(r.drip.schedule.map((s) => s.quantity).join(','), '10000,15000,25000');
});

test('the next part waits until the panel has finished the one before', async () => {
  shop._resetCache();
  const db = fake();
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 15000, 25000], intervalMinutes: 480 } }, ORDER), CFG);
  db.statusOf = () => 'In progress';
  db.makeDue(r.orderId);
  let run = await drip.processDue(CFG);
  assert.deepEqual(run.results, ['waiting']);
  const p2 = db.parts.find((p) => p.order_id === r.orderId && p.seq === 2);
  assert.equal(p2.status, 'scheduled');
  assert.equal(p2.attempts, 0, 'waiting doesn’t use up a try');
  assert.ok(Date.parse(p2.scheduled_at) > Date.now() + 9 * 60e3, 'checks again in 10 minutes');

  db.statusOf = () => 'Completed';
  db.parts.find((p) => p.order_id === r.orderId && p.seq === 2).scheduled_at = new Date(Date.now() - 1000).toISOString();
  db.parts.find((p) => p.order_id === r.orderId && p.seq === 3).scheduled_at = new Date(Date.now() + 3600e3).toISOString();
  run = await drip.processDue(CFG);
  assert.deepEqual(run.results, ['placed'], 'part 3 isn’t due yet');
  db.makeDue(r.orderId);
  await drip.processDue(CFG);
  assert.equal(db.orders[0].drip_state, 'done');
  assert.deepEqual(db.adds.map((a) => a.quantity), ['10000', '15000', '25000']);
});

test('a scheduler run stops starting new parts once its time is up', async () => {
  shop._resetCache();
  const db = fake();
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 15000, 25000], intervalMinutes: 480 } }, ORDER), CFG);
  db.statusOf = () => 'Completed';
  db.makeDue(r.orderId);
  const run = await drip.processDue(CFG, { budgetMs: -1 });
  assert.deepEqual(run.results, ['placed'], 'one part, then stop');
  assert.equal(db.parts.filter((p) => p.status === 'placing').length, 0, 'nothing left claimed but unsent');
  assert.equal(db.parts.find((p) => p.order_id === r.orderId && p.seq === 3).status, 'scheduled');
});

test('the panel refuses a part 3 times: the order stops and unsent parts are refunded', async () => {
  shop._resetCache();
  const db = fake();
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 15000, 25000], intervalMinutes: 480 } }, ORDER), CFG);
  db.addError = 'Not enough funds on balance';
  for (let i = 0; i < 3; i++) { db.makeDue(r.orderId); await drip.processDue(CFG); }
  const o = db.orders[0];
  assert.equal(o.drip_state, 'stopped');
  assert.equal(o.refunded, C.round(18 - 3.6, 4), 'parts 2 and 3 back in the wallet (part 1 = 10,000 of 50,000 = ₹3.60 was delivered)');
  assert.equal(db.wallet, C.round(82 + 14.4, 4));
  const st = await drip.orderStatus(USER, r.orderId, CFG);
  assert.match(st.status, /Stopped · ₹14.40 refunded/);
  assert.equal(st.canCancel, false);
});

test('the panel doesn’t answer: the part waits for a person to check, nothing is refunded or resent', async () => {
  shop._resetCache();
  const db = fake();
  db.addThrows = true;
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 40000], intervalMinutes: 700 } }, ORDER), CFG);
  assert.equal(db.parts.find((p) => p.order_id === r.orderId && p.seq === 1).status, 'checking');
  db.addThrows = false;
  db.makeDue(r.orderId);
  assert.equal((await drip.processDue(CFG)).claimed, 0, 'part 2 waits behind the part being checked');
  assert.equal(db.wallet, 82);
});

test('customers see one order with its parts, and can cancel the rest for a refund', async () => {
  shop._resetCache();
  const db = fake();
  const r = await drip.placeDripOrder(USER, Object.assign({ drip: { split: [10000, 15000, 25000], intervalMinutes: 480 } }, ORDER), CFG);
  const st = await drip.orderStatus(USER, r.orderId, CFG);
  assert.equal(st.drip, true);
  assert.equal(st.status, 'Gradual · 1 of 3 parts sent');
  assert.deepEqual(st.parts.map((p) => p.label), ['Completed', 'Scheduled', 'Scheduled']);
  assert.equal(st.delivered, 10000);
  assert.equal(st.canCancel, true);
  assert.ok(st.nextAt);
  await assert.rejects(drip.cancel({ id: 'someone-else' }, r.orderId, CFG), /not found/);
  const c = await drip.cancel(USER, r.orderId, CFG);
  assert.equal(c.refunded, 14.4);
  assert.equal(db.wallet, 96.4);
  await assert.rejects(drip.cancel(USER, r.orderId, CFG), /no parts left/);
  assert.match((await drip.orderStatus(USER, r.orderId, CFG)).status, /Canceled · ₹14.40 refunded/);
});

test('not enough balance: nothing is charged or sent', async () => {
  shop._resetCache();
  const db = fake();
  db.wallet = 5;
  await assert.rejects(drip.placeDripOrder(USER, Object.assign({ drip: { parts: 4, intervalMinutes: 600 } }, ORDER), CFG), (e) => { assert.equal(e.status, 402); assert.equal(e.extra.needed, 13); return true; });
  assert.equal(db.adds.length, 0);
  assert.equal(db.wallet, 5);
});
