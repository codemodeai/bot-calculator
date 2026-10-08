/*
 * What a customer can do with a placed order, through the panel's API (buttons under the order in My orders):
 *   refill - ask the panel to top up a completed order that dropped. Only services with refill; once a day.
 *   cancel - ask the panel to stop an order that hasn't finished. Only services with cancel. The panel decides:
 *            when it marks the order Canceled (or Partial), the undelivered share comes back to the wallet by
 *            itself (wallet.settlePanel / 008_order_actions.sql).
 * Gradual orders have their own cancel (lib/drip.js) and no refill.
 */
'use strict';

const shop = require('./shop');
const wallet = require('./wallet');
const C = require('../calculator');
const { ShopError } = shop;
const { sb } = wallet;
const q = encodeURIComponent;

const REFILL_GAP_MS = 24 * 3600e3;
const COLS = 'id,service_id,title,quantity,charge,status,smm_order,drip,refunded,refill_id,refill_at,cancel_requested_at';

async function load(user, id, cfg) {
  const n = parseInt(id, 10);
  const rows = n > 0 ? await sb(cfg, '/rest/v1/orders?select=' + COLS + '&id=eq.' + n + '&user_id=eq.' + q(user.id)) : null;
  if (!rows || !rows[0]) throw new ShopError('Order not found.', 404);
  return rows[0];
}

// The service's refill / cancel switches from the panel's list (null if the panel can't be reached).
async function flags(cfg, serviceId) {
  const c = await shop.costList(cfg).catch(() => null);
  const s = c && c.list.find((x) => x.id === String(serviceId));
  return s ? { refill: !!s.refill, cancel: !!s.cancel } : null;
}

// Which buttons to show, given the panel's current status (raw, lower case).
function actionsFor(o, f, raw) {
  const open = !o.drip && o.status === 'placed' && o.smm_order && !(Number(o.refunded) > 0);
  const refillWait = o.refill_at ? Date.parse(o.refill_at) + REFILL_GAP_MS - Date.now() : 0;
  return {
    canRefill: !!(open && f && f.refill && /complete/.test(raw) && refillWait <= 0),
    refillAgainAt: open && f && f.refill && refillWait > 0 ? new Date(Date.parse(o.refill_at) + REFILL_GAP_MS).toISOString() : null,
    canCancel: !!(open && f && f.cancel && raw && !wallet.FINAL.test(raw) && !o.cancel_requested_at),
    cancelRequested: !!(o.cancel_requested_at && o.status === 'placed' && !wallet.FINAL.test(raw || '')),
    refillable: !!(f && f.refill),
    cancelable: !!(f && f.cancel)
  };
}

// Status for the order details: the usual delivery status plus the actions and the last refill's progress.
async function orderStatus(user, id, cfg) {
  cfg = cfg || shop.config();
  const o = await load(user, id, cfg);
  const [s, f] = await Promise.all([wallet.orderStatus(user, id, cfg), flags(cfg, o.service_id)]);
  const fresh = s.status === 'Refunded' ? Object.assign(o, { status: 'refunded' }) : Object.assign(o, { refunded: s.refunded });
  const out = Object.assign(s, actionsFor(fresh, f, String(s.panel || '')));
  if (o.refill_id) {
    const r = await shop.smm({ action: 'refill_status', refill: o.refill_id }, cfg).catch(() => null);
    out.refill = { requestedAt: o.refill_at, status: r && !r.error && r.status ? String(r.status) : 'Requested' };
  }
  return out;
}

async function currentRaw(o, cfg) {
  const s = await shop.smm({ action: 'status', order: o.smm_order }, cfg).catch(() => null);
  if (!s || s.error || !s.status) throw new ShopError('Couldn’t reach the provider to check this order. Try again in a minute.', 502);
  return { raw: String(s.status).toLowerCase(), remains: s.remains };
}

async function refill(user, id, cfg) {
  cfg = cfg || shop.config();
  const o = await load(user, id, cfg);
  if (o.drip) throw new ShopError('Gradual orders can’t be refilled.');
  const f = await flags(cfg, o.service_id);
  if (!f) throw new ShopError('Couldn’t reach the provider. Try again in a minute.', 502);
  if (!f.refill) throw new ShopError('This service has no refill.');
  const { raw } = await currentRaw(o, cfg);
  const a = actionsFor(o, f, raw);
  if (a.refillAgainAt) throw new ShopError('You can ask for a refill again after ' + new Date(a.refillAgainAt).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + '.', 429);
  if (!a.canRefill) throw new ShopError(/complete/.test(raw) ? 'This order can’t be refilled.' : 'A refill can be asked for once the order is completed.');
  const r = await shop.smm({ action: 'refill', order: o.smm_order }, cfg).catch(() => null);
  if (!r) throw new ShopError('The provider didn’t answer. Try again in a minute.', 502);
  if (r.error || r.refill == null) throw new ShopError('The provider said: ' + String(r.error || 'refill not accepted'), 400);
  const at = new Date().toISOString();
  await sb(cfg, '/rest/v1/orders?id=eq.' + o.id, { method: 'PATCH', prefer: 'return=minimal', body: { refill_id: String(r.refill), refill_at: at } });
  return { ok: true, refill: { requestedAt: at, status: 'Requested' } };
}

async function cancel(user, id, cfg) {
  cfg = cfg || shop.config();
  const o = await load(user, id, cfg);
  if (o.drip) return require('./drip').cancel(user, id, cfg);        // gradual: cancel the parts not sent yet
  const f = await flags(cfg, o.service_id);
  if (!f) throw new ShopError('Couldn’t reach the provider. Try again in a minute.', 502);
  if (!f.cancel) throw new ShopError('This service can’t be canceled once it’s placed.');
  let { raw, remains } = await currentRaw(o, cfg);
  if (o.cancel_requested_at && !wallet.FINAL.test(raw)) throw new ShopError('Cancel already requested. The provider is on it.', 409);
  if (!actionsFor(o, f, raw).canCancel) throw new ShopError(wallet.FINAL.test(raw) ? 'This order is already finished.' : 'This order can’t be canceled.', 409);
  const r = await shop.smm({ action: 'cancel', orders: o.smm_order }, cfg).catch(() => null);
  if (!r) throw new ShopError('The provider didn’t answer. Try again in a minute.', 502);
  // v2 panels answer [{ order, cancel: 1 }] or [{ order, cancel: { error } }]
  const row = Array.isArray(r) ? r.find((x) => String(x.order) === String(o.smm_order)) || r[0] : r;
  const res = row && (row.cancel !== undefined ? row.cancel : row);
  const err = !row ? 'no answer' : res && typeof res === 'object' ? res.error : res ? null : 'not accepted';
  if (err) throw new ShopError('The provider said: ' + String(err), 400);
  await sb(cfg, '/rest/v1/orders?id=eq.' + o.id, { method: 'PATCH', prefer: 'return=minimal', body: { cancel_requested_at: new Date().toISOString() } });
  // some panels cancel straight away: refund now if so
  ({ raw, remains } = await currentRaw(o, cfg).catch(() => ({ raw: '', remains: null })));
  const refunded = await wallet.settlePanel(cfg, o, raw, remains).catch(() => 0);
  if (refunded) await wallet.savePanelStatus(cfg, o.id, raw);
  return { ok: true, refunded, balance: refunded ? await wallet.balanceOf(user, cfg) : undefined };
}

module.exports = { orderStatus, refill, cancel, actionsFor, REFILL_GAP_MS };
