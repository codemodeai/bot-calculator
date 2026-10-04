/*
 * Customer wallets (Supabase): sign-in check, recharges through Razorpay, and orders paid from the balance.
 * Balances only change inside the SQL functions in supabase/migrations/001_wallet.sql, which lock the row,
 * so two tabs or a webhook retry can't spend or credit the same money twice.
 */
'use strict';

const shop = require('./shop');
const C = require('../calculator');
const { ShopError } = shop;

const MIN_RECHARGE = 1;          // Razorpay's smallest payment
const MAX_RECHARGE = 50000;

function requireLive(cfg) {
  if (shop.mode(cfg) !== 'live') throw new ShopError('The wallet isn’t connected yet.', 503);
}

async function sb(cfg, path, opts) {
  opts = opts || {};
  const headers = { apikey: cfg.supabaseService, Authorization: 'Bearer ' + cfg.supabaseService, 'Content-Type': 'application/json' };
  if (opts.prefer) headers.Prefer = opts.prefer;
  const r = await shop.fetchJson(cfg.supabaseUrl + path, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  if (r.status >= 400) {
    const msg = (r.body && (r.body.message || r.body.error)) || 'Database error ' + r.status;
    const e = new ShopError('Database error. Please try again.', 500);
    e.db = String(msg);
    throw e;
  }
  return r.body;
}
const rpc = (cfg, fn, args) => sb(cfg, '/rest/v1/rpc/' + fn, { method: 'POST', body: args });
const q = encodeURIComponent;

// The signed-in customer, from the Supabase access token the browser sends.
async function currentUser(req, cfg) {
  cfg = cfg || shop.config();
  requireLive(cfg);
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new ShopError('Please sign in.', 401);
  const r = await shop.fetchJson(cfg.supabaseUrl + '/auth/v1/user', { headers: { apikey: cfg.supabaseAnon, Authorization: 'Bearer ' + token } });
  if (r.status !== 200 || !r.body || !r.body.id) throw new ShopError('Your session expired. Please sign in again.', 401);
  return { id: r.body.id, email: r.body.email || '' };
}

async function balanceOf(user, cfg) {
  const rows = await sb(cfg, '/rest/v1/wallets?select=balance&user_id=eq.' + q(user.id));
  return rows && rows[0] ? Number(rows[0].balance) : 0;
}

async function wallet(user, cfg) {
  cfg = cfg || shop.config();
  const [balance, orders, recharges] = await Promise.all([
    balanceOf(user, cfg),
    sb(cfg, '/rest/v1/orders?select=id,title,link,quantity,charge,status,smm_order,error,created_at&order=created_at.desc&limit=30&user_id=eq.' + q(user.id)),
    sb(cfg, '/rest/v1/recharges?select=amount,razorpay_payment_id,paid_at&status=eq.paid&order=paid_at.desc&limit=10&user_id=eq.' + q(user.id))
  ]);
  return {
    email: user.email,
    balance,
    orders: (orders || []).map((o) => Object.assign(o, { charge: Number(o.charge) })),
    recharges: (recharges || []).map((r) => ({ amount: Number(r.amount), paymentId: r.razorpay_payment_id, at: r.paid_at }))
  };
}

// ---------- recharge ----------

function rechargeAmount(v) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!(n >= MIN_RECHARGE)) throw new ShopError('The minimum recharge is ₹' + MIN_RECHARGE + '.');
  if (n > MAX_RECHARGE) throw new ShopError('The maximum recharge is ₹' + MAX_RECHARGE.toLocaleString('en-IN') + '.');
  return n;
}

async function createRecharge(user, input, cfg) {
  cfg = cfg || shop.config();
  const amount = rechargeAmount(input && input.amount);
  const order = await shop.rzp('POST', '/orders', {
    amount: Math.round(amount * 100),
    currency: 'INR',
    receipt: 'wallet_' + Date.now().toString(36),
    notes: { purpose: 'recharge', user_id: user.id, email: user.email }
  }, cfg);
  await sb(cfg, '/rest/v1/recharges', { method: 'POST', prefer: 'return=minimal', body: { user_id: user.id, razorpay_order_id: order.id, amount } });
  return { orderId: order.id, amount: order.amount, currency: 'INR', keyId: cfg.keyId, storeName: cfg.storeName, email: user.email };
}

// Credit a captured Razorpay payment to the wallet it was created for. Safe to call any number of times.
async function creditPayment(paymentId, cfg) {
  let pay = await shop.rzp('GET', '/payments/' + q(paymentId), null, cfg);
  if (pay.status === 'authorized') {
    pay = await shop.rzp('POST', '/payments/' + pay.id + '/capture', { amount: pay.amount, currency: pay.currency }, cfg);
  }
  if (pay.status !== 'captured') throw new ShopError('Payment is ' + pay.status + ', not completed.', 402);
  const rows = await sb(cfg, '/rest/v1/recharges?select=user_id,amount&razorpay_order_id=eq.' + q(pay.order_id));
  const rec = rows && rows[0];
  if (!rec) throw new ShopError('This payment isn’t a wallet recharge.', 400);
  if (Math.round(Number(rec.amount) * 100) !== pay.amount) throw new ShopError('Amount mismatch.', 400);
  const balance = await rpc(cfg, 'credit_recharge', { p_razorpay_order_id: pay.order_id, p_payment_id: pay.id });
  return { userId: rec.user_id, balance: Number(balance), amount: pay.amount / 100, paymentId: pay.id };
}

async function verifyRecharge(user, body, cfg) {
  cfg = cfg || shop.config();
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig } = body || {};
  if (!shop.verifyCheckoutSignature(o, p, sig, cfg.keySecret)) throw new ShopError('Payment signature check failed.', 400);
  const r = await creditPayment(p, cfg);
  if (r.userId !== user.id) throw new ShopError('This payment belongs to another account.', 403);
  return { balance: r.balance, amount: r.amount, paymentId: r.paymentId };
}

// ---------- orders ----------

async function placeOrder(user, input, cfg) {
  cfg = cfg || shop.config();
  const p = await shop.priceOrder(input || {}, cfg);
  let placed;
  try {
    placed = await rpc(cfg, 'place_order', {
      p_user: user.id, p_service_id: p.service.id, p_title: p.title, p_link: p.link,
      p_quantity: p.quantity, p_charge: p.charge, p_cost: p.cost
    });
  } catch (e) {
    if (e.db && /INSUFFICIENT_FUNDS/.test(e.db)) {
      const balance = await balanceOf(user, cfg);
      throw new ShopError('Not enough balance. Add money to your wallet first.', 402, { balance, charge: p.charge, needed: Math.max(0, p.charge - balance) });
    }
    throw e;
  }
  const row = Array.isArray(placed) ? placed[0] : placed;
  const orderId = row.order_id;

  let r;
  try {
    r = await shop.smm({ action: 'add', service: p.service.id, link: p.link, quantity: p.quantity }, cfg);
  } catch (e) {
    // No answer: the panel may have placed it, so don't refund automatically.
    await rpc(cfg, 'fail_order', { p_order: orderId, p_error: 'Panel did not answer', p_refund: false }).catch(() => {});
    throw new ShopError('The panel didn’t answer. We’ll check order #' + orderId + ' and refund it if it wasn’t placed.', 502, { orderId });
  }
  if (!r || r.order == null) {
    const err = String((r && r.error) || 'Unknown panel error').slice(0, 200);
    const balance = await rpc(cfg, 'fail_order', { p_order: orderId, p_error: err, p_refund: true });
    throw new ShopError('The order couldn’t be placed (' + err + '). ' + C.formatPrice(p.charge, 'INR') + ' is back in your wallet.', 502, { orderId, balance: Number(balance) });
  }
  await rpc(cfg, 'finish_order', { p_order: orderId, p_smm_order: String(r.order) });
  return { orderId, smmOrder: String(r.order), charge: p.charge, balance: Number(row.balance), title: p.title };
}

const STATUS_LABEL = {
  pending: 'Queued', 'in progress': 'In progress', processing: 'In progress', completed: 'Completed',
  partial: 'Partially delivered', canceled: 'Canceled', cancelled: 'Canceled'
};

async function orderStatus(user, id, cfg) {
  cfg = cfg || shop.config();
  const n = parseInt(id, 10);
  if (!(n > 0)) throw new ShopError('Unknown order.');
  const rows = await sb(cfg, '/rest/v1/orders?select=id,title,link,quantity,charge,status,smm_order,error,created_at&id=eq.' + n + '&user_id=eq.' + q(user.id));
  const o = rows && rows[0];
  if (!o) throw new ShopError('Order not found.', 404);
  const base = { orderId: o.id, title: o.title, link: o.link, quantity: o.quantity, charge: Number(o.charge), createdAt: o.created_at };
  if (o.status === 'refunded') return Object.assign(base, { status: 'Refunded', state: 'error', note: o.error ? 'Panel said: ' + o.error : '' });
  if (o.status === 'checking' || o.status === 'placing') return Object.assign(base, { status: 'Being checked', state: 'pending', note: 'We’re confirming this order with the panel.' });
  const s = await shop.smm({ action: 'status', order: o.smm_order }, cfg);
  const raw = String((s && s.status) || 'pending').toLowerCase();
  return Object.assign(base, {
    status: STATUS_LABEL[raw] || (s && s.status) || 'Queued',
    state: /complete/.test(raw) ? 'done' : /cancel/.test(raw) ? 'error' : /partial/.test(raw) ? 'partial' : /progress|processing/.test(raw) ? 'progress' : 'pending',
    startCount: s && s.start_count != null ? Number(s.start_count) : null,
    remains: s && s.remains != null ? Number(s.remains) : null
  });
}

module.exports = { MIN_RECHARGE, currentUser, wallet, createRecharge, verifyRecharge, creditPayment, placeOrder, orderStatus, rechargeAmount };
