/*
 * Gradual delivery: one order, split into parts that go to the panel one after another.
 *
 *   customer -> /api/order { ..., drip: { parts | split, intervalMinutes } }
 *            -> whole price (+20%) taken from the wallet, parts saved with their times (005_drip.sql)
 *            -> part 1 sent at once; later parts sent by processDue() when their time comes
 *
 * processDue() runs from /api/drip (Supabase's scheduler calls it every few minutes) and whenever a customer with a
 * running gradual order opens the store. Before sending a part it checks the panel has finished the one before;
 * if not, it waits 10 minutes. If the panel refuses a part 3 times, the order stops and unsent parts are refunded.
 */
'use strict';

const shop = require('./shop');
const wallet = require('./wallet');
const C = require('../calculator');
const { ShopError } = shop;
const { sb, rpc } = wallet;
const q = encodeURIComponent;
const first = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;

function minutesLabel(m) {
  if (m % 1440 === 0) return m / 1440 + (m === 1440 ? ' day' : ' days');
  if (m % 60 === 0) return m / 60 + (m === 60 ? ' hour' : ' hours');
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' minutes';
}

// The parts and the gap between them, checked against the service. Random split unless the customer gave one.
function plan(svc, quantity, d) {
  d = d || {};
  let split = Array.isArray(d.split) ? d.split.map(Number) : null;
  if (!split) {
    const parts = parseInt(d.parts, 10);
    if (!(parts >= C.DRIP.minParts && parts <= C.DRIP.maxParts)) throw new ShopError('Choose ' + C.DRIP.minParts + ' to ' + C.DRIP.maxParts + ' parts.');
    split = C.splitQuantity(quantity, parts, svc.min, svc.max);
    if (!split) throw new ShopError(quantity.toLocaleString('en-IN') + ' can’t be split into ' + parts + ' parts of at least ' + svc.min.toLocaleString('en-IN') + ' each. Use fewer parts.');
  }
  const err = C.checkSplit(split, svc, quantity);
  if (err) throw new ShopError(err);
  const minInterval = C.dripMinInterval(svc, split);
  const interval = parseInt(d.intervalMinutes, 10);
  if (!(interval >= minInterval)) throw new ShopError('For this service, parts need at least ' + minutesLabel(minInterval) + ' between them (that’s how long the provider takes to deliver one).');
  if (interval > C.DRIP.maxInterval) throw new ShopError('The gap between parts can be at most 7 days.');
  return { split, interval, minInterval };
}

async function placeDripOrder(user, input, cfg) {
  cfg = cfg || shop.config();
  const p = await shop.priceOrder(input || {}, cfg);                     // service, quantity and link checks
  const { split, interval } = plan(p.service, p.quantity, input.drip);
  const charge = C.dripCharge(shop.sellRate(p.service.rate, cfg), p.quantity);
  const start = Date.now();
  let left = charge;
  const parts = split.map((qty, i) => {
    const share = i === split.length - 1 ? C.round(left, 4) : C.round(charge * qty / p.quantity, 4);
    left = C.round(left - share, 4);
    return { quantity: qty, charge: share, cost: C.exactCharge(p.service.rate, qty), at: new Date(start + i * interval * 60e3).toISOString() };
  });
  let placed;
  try {
    placed = await rpc(cfg, 'place_drip_order', {
      p_user: user.id, p_service_id: p.service.id, p_title: p.title, p_link: p.link, p_quantity: p.quantity,
      p_charge: charge, p_cost: p.cost, p_interval: interval, p_parts: parts
    });
  } catch (e) {
    if (e.db && /INSUFFICIENT_FUNDS/.test(e.db)) {
      const balance = await wallet.balanceOf(user, cfg);
      throw new ShopError('Not enough balance. Add money to your wallet first.', 402, { balance, charge, needed: Math.max(0, charge - balance) });
    }
    throw e;
  }
  const row = first(placed);
  await processDue(cfg, { orderId: row.order_id }).catch(() => null);   // part 1 goes now
  return {
    orderId: row.order_id, charge, balance: Number(row.balance), title: p.title,
    drip: { parts: split.length, intervalMinutes: interval, schedule: parts.map((x) => ({ quantity: x.quantity, at: x.at })) }
  };
}

// ---------- the scheduler ----------

const FINISHED = /complete|partial|cancel|refund/;

async function runPart(cfg, part) {
  if (part.prev_smm) {
    let s = null;
    try { s = await shop.smm({ action: 'status', order: part.prev_smm }, cfg); } catch (e) { s = null; }
    if (!s) {
      await rpc(cfg, 'postpone_part', { p_part: part.part_id, p_minutes: 10, p_note: 'Couldn’t reach the panel to check part ' + (part.seq - 1), p_undo_attempt: true });
      return 'postponed';
    }
    // An unknown order id (s.error) shouldn't block the rest forever, so only a real "still running" status waits.
    if (!s.error && !FINISHED.test(String(s.status || '').toLowerCase())) {
      await rpc(cfg, 'postpone_part', { p_part: part.part_id, p_minutes: 10, p_note: 'Waiting for part ' + (part.seq - 1) + ' to finish', p_undo_attempt: true });
      return 'waiting';
    }
  }
  let r;
  try {
    r = await shop.smm({ action: 'add', service: part.service_id, link: part.link, quantity: part.quantity }, cfg);
  } catch (e) {
    await rpc(cfg, 'check_part', { p_part: part.part_id, p_note: 'Panel did not answer' });   // may be on the panel: a person checks
    return 'checking';
  }
  if (r && r.order != null) {
    await rpc(cfg, 'finish_part', { p_part: part.part_id, p_smm_order: String(r.order) });
    return 'placed';
  }
  await rpc(cfg, 'fail_part', { p_part: part.part_id, p_error: String((r && r.error) || 'Unknown panel error').slice(0, 200) });
  return 'failed';
}

// Send the parts that are due (optionally only one order's). Safe to run from several places at once.
// Parts are claimed one at a time and no new one starts after opts.budgetMs, so a claimed part is never left
// unsent when Vercel stops the function (a part cut off mid-send still lands in 'checking' for a person).
async function processDue(cfg, opts) {
  cfg = cfg || shop.config();
  opts = opts || {};
  const limit = opts.limit || 10, start = Date.now(), budget = opts.budgetMs || 8000;
  const results = [];
  while (results.length < limit && (results.length === 0 || Date.now() - start < budget)) {
    const part = first(await rpc(cfg, 'claim_due_parts', { p_limit: 1, p_order: opts.orderId || null }));
    if (!part) break;
    results.push(await runPart(cfg, part).catch(() => 'error'));
  }
  return { claimed: results.length, results };
}

// When a customer opens the store, send their due parts too (backup for the scheduler).
async function runDueForUser(user, cfg) {
  const rows = await sb(cfg, '/rest/v1/orders?select=id&drip_state=eq.running&limit=5&user_id=eq.' + q(user.id));
  for (const o of rows || []) await processDue(cfg, { orderId: o.id, limit: 2 }).catch(() => null);
}

// ---------- what the customer sees ----------

const PART_COLS = 'order_id,seq,quantity,status,smm_order,scheduled_at,placed_at,error';

async function attachParts(cfg, orders) {
  const ids = (orders || []).filter((o) => o.drip).map((o) => o.id);
  if (!ids.length) return orders;
  const parts = await sb(cfg, '/rest/v1/order_parts?select=' + PART_COLS + '&order=seq.asc&order_id=in.(' + ids.join(',') + ')');
  orders.forEach((o) => { if (o.drip) o.parts_list = (parts || []).filter((p) => p.order_id === o.id).map((p) => ({ seq: p.seq, quantity: p.quantity, status: p.status, at: p.placed_at || p.scheduled_at })); });
  return orders;
}

const ORDER_COLS = 'id,title,link,quantity,charge,status,smm_order,error,created_at,drip,drip_state,parts,interval_minutes,refunded';

async function orderStatus(user, id, cfg) {
  cfg = cfg || shop.config();
  const n = parseInt(id, 10);
  if (!(n > 0)) throw new ShopError('Unknown order.');
  const o = first(await sb(cfg, '/rest/v1/orders?select=' + ORDER_COLS + '&id=eq.' + n + '&user_id=eq.' + q(user.id)));
  if (!o) throw new ShopError('Order not found.', 404);
  if (!o.drip) return wallet.orderStatus(user, id, cfg);
  if (o.drip_state === 'running') await processDue(cfg, { orderId: o.id, limit: 2 }).catch(() => null);
  const [order, parts] = await Promise.all([
    sb(cfg, '/rest/v1/orders?select=drip_state,refunded&id=eq.' + n).then(first),
    sb(cfg, '/rest/v1/order_parts?select=' + PART_COLS + '&order=seq.asc&order_id=eq.' + n)
  ]);
  const sent = (parts || []).filter((p) => p.smm_order);
  let live = {};
  if (sent.length) {
    const r = await shop.smm({ action: 'status', orders: sent.map((p) => p.smm_order).join(',') }, cfg).catch(() => null);
    if (r && !r.error) live = r;
  }
  let delivered = 0, allDone = true;
  const list = (parts || []).map((p) => {
    const s = p.smm_order ? live[p.smm_order] || {} : {};
    const raw = String(s.status || '').toLowerCase();
    const got = /complete/.test(raw) ? p.quantity : s.remains != null && p.smm_order ? Math.max(0, p.quantity - Number(s.remains)) : 0;
    delivered += p.status === 'placed' ? got : 0;
    if (p.status === 'placed' && !/complete/.test(raw)) allDone = false;
    const label = p.status === 'placed' ? (raw ? raw.replace(/^\w/, (c) => c.toUpperCase()) : 'Sent') :
      { scheduled: 'Scheduled', placing: 'Sending', checking: 'Being checked', failed: 'Failed (refunded)', canceled: 'Canceled (refunded)' }[p.status] || p.status;
    return { seq: p.seq, quantity: p.quantity, status: p.status, label, delivered: got, at: p.placed_at || p.scheduled_at, note: p.status === 'scheduled' && p.error ? p.error : '' };
  });
  const state = order.drip_state, refunded = Number(order.refunded) || 0, done = list.filter((p) => p.status === 'placed').length;
  if (state === 'done' && sent.length && Object.keys(live).length) {
    const raw = allDone ? 'completed' : (parts || []).every((p) => p.status !== 'placed' || FINAL.test(String((live[p.smm_order] || {}).status || '').toLowerCase())) ? 'partial' : 'in progress';
    await wallet.savePanelStatus(cfg, o.id, raw);
  }
  const next = list.find((p) => p.status === 'scheduled');
  const view = state === 'running' ? { status: 'Gradual · ' + done + ' of ' + list.length + ' parts sent', state: 'progress' }
    : state === 'done' ? (allDone ? { status: 'Completed', state: 'done' } : { status: 'All parts sent', state: 'progress' })
    : state === 'canceled' ? { status: 'Canceled · ' + C.formatPrice(refunded, 'INR') + ' refunded', state: 'partial' }
    : { status: 'Stopped · ' + C.formatPrice(refunded, 'INR') + ' refunded', state: 'error', note: o.error || '' };
  return Object.assign({
    orderId: o.id, title: o.title, link: o.link, quantity: o.quantity, charge: Number(o.charge), createdAt: o.created_at,
    drip: true, parts: list, delivered, remains: Math.max(0, o.quantity - delivered), sentParts: done, intervalMinutes: o.interval_minutes,
    nextAt: next ? next.at : null, refunded, canCancel: state === 'running' && !!next
  }, view);
}

async function cancel(user, id, cfg) {
  cfg = cfg || shop.config();
  let r;
  try {
    r = await rpc(cfg, 'cancel_drip', { p_order: parseInt(id, 10), p_user: user.id });
  } catch (e) {
    if (/ORDER_NOT_FOUND/.test(e.db || '')) throw new ShopError('Order not found.', 404);
    if (/NOT_RUNNING/.test(e.db || '')) throw new ShopError('This order has no parts left to cancel.', 409);
    throw e;
  }
  return { refunded: Number(r.refunded) || 0, balance: Number(r.balance) || 0 };
}

module.exports = { plan, placeDripOrder, processDue, runPart, runDueForUser, attachParts, orderStatus, cancel, minutesLabel, ORDER_COLS };
