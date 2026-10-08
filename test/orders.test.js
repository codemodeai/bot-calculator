const test = require('node:test');
const assert = require('node:assert/strict');
const shop = require('../lib/shop');
const orders = require('../lib/orders');

const CFG = { smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', markup: 50, roundPrices: false, fx: 0, supabaseUrl: 'https://db.test', supabaseAnon: 'anon', supabaseService: 'service-key' };
const USER = { id: 'u1', email: 'c@x.com' };
const svc = (id, refill, cancel) => ({ service: id, name: 'Instagram Likes ' + id, type: 'Default', category: 'Instagram Likes', rate: '1.00', min: 10, max: 10000, refill, cancel });

// Fake panel (services with refill/cancel switches, status, refill, cancel) and Supabase (one order row, wallet).
function fake(o, panel) {
  shop._resetCache();
  const db = { order: Object.assign({ id: 5, service_id: '1', title: '500 Instagram Likes', quantity: 500, charge: 3.95, status: 'placed', smm_order: '777', drip: false, refunded: 0, refill_id: null, refill_at: null, cancel_requested_at: null, user_id: 'u1' }, o),
    calls: [], patches: [], settled: [] };
  const reply = (status, data) => ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  global.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url);
    if (u.host === 'panel.test') {
      const f = Object.fromEntries(new URLSearchParams(init.body));
      db.calls.push(f.action);
      if (f.action === 'services') return reply(200, [svc(1, true, true), svc(2, false, false)]);
      if (f.action === 'balance') return reply(200, { balance: '5', currency: 'INR' });
      if (f.action === 'status') return reply(200, panel.status());
      if (f.action === 'refill') return reply(200, panel.refill || { refill: '55' });
      if (f.action === 'refill_status') return reply(200, { status: 'Completed' });
      if (f.action === 'cancel') return reply(200, panel.cancel || [{ order: Number(f.orders), cancel: 1 }]);
    }
    if (u.pathname === '/rest/v1/orders' && init.method === 'PATCH') { const d = JSON.parse(init.body); db.patches.push(d); Object.assign(db.order, d); return reply(204); }
    if (u.pathname === '/rest/v1/orders') return reply(200, u.searchParams.get('user_id') === 'eq.u1' ? [db.order] : []);
    if (u.pathname === '/rest/v1/rpc/settle_panel_order') { const d = JSON.parse(init.body); db.settled.push(d.p_status); return reply(200, { refunded: /cancel/.test(d.p_status) ? 3.95 : 0, balance: 10 }); }
    if (u.pathname === '/rest/v1/wallets') return reply(200, [{ balance: 10 }]);
    return reply(404, { message: 'no route ' + u.pathname });
  };
  return db;
}
const panelSays = (status, remains) => ({ status: () => ({ status, remains: String(remains || 0), start_count: '3' }) });

test('order details offer refill once completed, cancel while running, per the service’s switches', async () => {
  fake({}, panelSays('In progress', 500));
  let s = await orders.orderStatus(USER, 5, CFG);
  assert.equal(s.canCancel, true); assert.equal(s.canRefill, false);
  fake({}, panelSays('Completed'));
  s = await orders.orderStatus(USER, 5, CFG);
  assert.equal(s.canCancel, false); assert.equal(s.canRefill, true);
  fake({ service_id: '2' }, panelSays('In progress', 500));
  s = await orders.orderStatus(USER, 5, CFG);
  assert.equal(s.canCancel, false, 'service without cancel'); assert.equal(s.cancelable, false);
  fake({ refill_id: '55', refill_at: new Date().toISOString() }, panelSays('Completed'));
  s = await orders.orderStatus(USER, 5, CFG);
  assert.equal(s.canRefill, false, 'once a day');
  assert.ok(s.refillAgainAt);
  assert.deepEqual(s.refill.status, 'Completed', 'last refill’s progress');
});

test('refill goes to the panel and is remembered', async () => {
  const db = fake({}, panelSays('Completed'));
  const r = await orders.refill(USER, 5, CFG);
  assert.equal(r.ok, true);
  assert.ok(db.calls.includes('refill'));
  assert.equal(db.patches[0].refill_id, '55');
  await assert.rejects(orders.refill(USER, 5, CFG), (e) => e.status === 429 && /again after/.test(e.message));
  fake({}, panelSays('In progress', 100));
  await assert.rejects(orders.refill(USER, 5, CFG), /once the order is completed/);
  fake({}, Object.assign(panelSays('Completed'), { refill: { error: 'Refill is not available for this order' } }));
  await assert.rejects(orders.refill(USER, 5, CFG), /The provider said: Refill is not available/);
  fake({ service_id: '2' }, panelSays('Completed'));
  await assert.rejects(orders.refill(USER, 5, CFG), /no refill/);
  await assert.rejects(orders.refill({ id: 'someone-else' }, 5, CFG), (e) => e.status === 404);
});

test('cancel asks the panel; the money comes back when the panel confirms', async () => {
  let n = 0;
  let db = fake({}, { status: () => ({ status: n++ ? 'In progress' : 'Pending', remains: '500' }) });
  let r = await orders.cancel(USER, 5, CFG);
  assert.deepEqual([r.ok, r.refunded], [true, 0], 'requested, not refunded yet');
  assert.ok(db.patches[0].cancel_requested_at);
  await assert.rejects(orders.cancel(USER, 5, CFG), /already requested/);

  n = 0;
  db = fake({}, { status: () => ({ status: n++ ? 'Canceled' : 'Pending', remains: '500' }) });
  r = await orders.cancel(USER, 5, CFG);
  assert.deepEqual([r.refunded, r.balance], [3.95, 10], 'panel canceled at once: refunded now');

  fake({}, Object.assign(panelSays('Pending', 500), { cancel: [{ order: 777, cancel: { error: 'Cancel is not available' } }] }));
  await assert.rejects(orders.cancel(USER, 5, CFG), /The provider said: Cancel is not available/);
  fake({}, panelSays('Completed'));
  await assert.rejects(orders.cancel(USER, 5, CFG), /already finished/);
  fake({ service_id: '2' }, panelSays('Pending', 500));
  await assert.rejects(orders.cancel(USER, 5, CFG), /can’t be canceled once/);
});
