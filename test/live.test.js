const test = require('node:test');
const assert = require('node:assert/strict');
const wallet = require('../lib/wallet');

const CFG = { smmUrl: 'https://panel.test/api/v2', smmKey: 'panel-key', supabaseUrl: 'https://db.test', supabaseAnon: 'anon', supabaseService: 'service-key' };

// Fake Supabase (saved panel statuses, gradual parts) and panel (multi-order status).
function fake(opts) {
  const db = { saved: Object.assign({}, opts.saved), parts: opts.parts || [], panel: opts.panel || {}, asked: [], writes: [] };
  const reply = (status, data) => ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  global.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url);
    if (u.host === 'panel.test') {
      const f = new URLSearchParams(init.body);
      db.asked.push(f.get('orders'));
      if (opts.panelDown) throw new Error('down');
      return reply(200, Object.fromEntries(f.get('orders').split(',').map((n) => [n, db.panel[n] || { error: 'Incorrect order ID' }])));
    }
    if (u.pathname === '/rest/v1/orders' && init.method === 'PATCH') { db.writes.push([u.searchParams.get('id'), JSON.parse(init.body).panel_status]); return reply(204); }
    if (u.pathname === '/rest/v1/orders') {
      if (opts.noColumn) return reply(400, { message: 'column orders.panel_status does not exist' });
      const ids = u.searchParams.get('id').replace(/^in\.\(|\)$/g, '').split(',');
      return reply(200, ids.map((id) => ({ id: Number(id), panel_status: db.saved[id] || null })));
    }
    if (u.pathname === '/rest/v1/order_parts') return reply(200, db.parts);
    return reply(404, {});
  };
  return db;
}
const order = (id, extra) => Object.assign({ id, status: 'placed', smm_order: String(9000 + id), drip: false }, extra);

test('the order list shows the panel’s live status and saves it', async () => {
  const db = fake({ panel: { 9003: { status: 'Completed', remains: '0' }, 9004: { status: 'In progress', remains: '150' } } });
  const orders = await wallet.attachLive(CFG, [order(4), order(3), order(2, { status: 'refunded', smm_order: null })]);
  assert.deepEqual(db.asked, ['9004,9003'], 'one panel call for all open orders');
  assert.deepEqual(orders[1].live, { status: 'Completed', state: 'done', remains: 0 });
  assert.deepEqual(orders[0].live, { status: 'In progress', state: 'progress', remains: 150 });
  assert.equal(orders[2].live, undefined, 'refunded orders aren’t asked about');
  assert.deepEqual(db.writes.sort(), [['eq.3', 'completed'], ['eq.4', 'in progress']]);
});

test('finished orders come from the database without asking the panel again', async () => {
  const db = fake({ saved: { 3: 'completed', 4: 'in progress' }, panel: { 9004: { status: 'Partial', remains: '20' } } });
  const orders = await wallet.attachLive(CFG, [order(4), order(3)]);
  assert.deepEqual(db.asked, ['9004']);
  assert.equal(orders[1].live.status, 'Completed');
  assert.equal(orders[0].live.status, 'Partially delivered');
  assert.deepEqual(db.writes, [['eq.4', 'partial']]);
});

test('a gradual order with every part sent is Completed once the panel finished every part', async () => {
  const parts = [{ order_id: 7, smm_order: '1' }, { order_id: 7, smm_order: '2' }];
  let db = fake({ parts, panel: { 1: { status: 'Completed' }, 2: { status: 'In progress' } } });
  let orders = await wallet.attachLive(CFG, [order(7, { drip: true, drip_state: 'done', smm_order: null }), order(8, { drip: true, drip_state: 'running', smm_order: null })]);
  assert.equal(orders[0].live.status, 'In progress');
  assert.equal(orders[1].live, undefined, 'a running gradual order keeps its own “Gradual · x/y”');
  db = fake({ parts, panel: { 1: { status: 'Completed' }, 2: { status: 'Completed' } } });
  orders = await wallet.attachLive(CFG, [order(7, { drip: true, drip_state: 'done', smm_order: null })]);
  assert.equal(orders[0].live.status, 'Completed');
  assert.deepEqual(db.writes, [['eq.7', 'completed']]);
});

test('panel down or the column not added yet: the list still loads', async () => {
  let db = fake({ panelDown: true });
  let orders = await wallet.attachLive(CFG, [order(4)]);
  assert.equal(orders[0].live, undefined);
  db = fake({ noColumn: true, panel: { 9004: { status: 'Completed' } } });
  orders = await wallet.attachLive(CFG, [order(4)]);
  assert.equal(orders[0].live.status, 'Completed', 'still shown');
  assert.deepEqual(db.writes, [], 'nothing saved without the column');
});
