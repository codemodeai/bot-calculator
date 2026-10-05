/*
 * Customer wallets (Supabase): sign-in check, UPI recharges, and orders paid from the balance.
 * Balances only change inside the SQL functions in supabase/migrations/ (001 orders, 003 UPI), which lock
 * the rows, so two tabs or two inbox checks can't spend or credit the same money twice.
 */
'use strict';

const shop = require('./shop');
const upi = require('./upi');
const C = require('../calculator');
const { ShopError } = shop;

const MIN_RECHARGE = 1;
const MAX_RECHARGE = 50000;

function requireLive(cfg) {
  if (shop.mode(cfg) !== 'live') throw new ShopError('The wallet isn’t connected yet.', 503);
}

async function sb(cfg, path, opts) {
  opts = opts || {};
  const headers = { apikey: cfg.supabaseService, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must only be sent as apikey.
  if (!/^sb_/.test(cfg.supabaseService)) headers.Authorization = 'Bearer ' + cfg.supabaseService;
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
  return { id: r.body.id, email: r.body.email || '', verified: !!r.body.email_confirmed_at };
}

async function balanceOf(user, cfg) {
  const rows = await sb(cfg, '/rest/v1/wallets?select=balance&user_id=eq.' + q(user.id));
  return rows && rows[0] ? Number(rows[0].balance) : 0;
}

async function wallet(user, cfg) {
  cfg = cfg || shop.config();
  // A recharge paid while the page was closed gets credited here, on the customer's next visit.
  const open = await sb(cfg, '/rest/v1/recharges?select=id&status=eq.pending&limit=1&user_id=eq.' + q(user.id) +
    '&expires_at=gt.' + q(new Date(Date.now() - GRACE_MS).toISOString()));
  if (open && open.length) await syncInbox(cfg).catch(() => {});
  const [balance, orders, recharges] = await Promise.all([
    balanceOf(user, cfg),
    sb(cfg, '/rest/v1/orders?select=id,title,link,quantity,charge,status,smm_order,error,created_at,drip,drip_state,parts,interval_minutes,refunded&order=created_at.desc&limit=30&user_id=eq.' + q(user.id)),
    sb(cfg, '/rest/v1/recharges?select=credited,utr,paid_at&status=eq.paid&order=paid_at.desc&limit=10&user_id=eq.' + q(user.id))
  ]);
  return {
    email: user.email,
    balance,
    orders: (orders || []).map((o) => Object.assign(o, { charge: Number(o.charge), refunded: Number(o.refunded) || 0 })),
    recharges: (recharges || []).map((r) => ({ amount: Number(r.credited), utr: r.utr, at: r.paid_at }))
  };
}

// ---------- recharge (UPI) ----------

const GRACE_MS = 30 * 60 * 1000;      // a payment can still be matched this long after its QR expires (see 003_upi.sql)
const first = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;

function rechargeAmount(v) {
  const n = Math.round(Number(v) * 100) / 100;
  if (!(n >= MIN_RECHARGE)) throw new ShopError('The minimum recharge is ₹' + MIN_RECHARGE + '.');
  if (n > MAX_RECHARGE) throw new ShopError('The maximum recharge is ₹' + MAX_RECHARGE.toLocaleString('en-IN') + '.');
  return n;
}

// What the checkout needs: the exact amount, the UPI link and its QR.
async function checkout(row, cfg) {
  const expected = Number(row.expected_amount);
  const link = upi.payLink({ vpa: cfg.upiId, name: cfg.upiName, amount: expected, ref: row.ref });
  return {
    id: row.id, amount: Number(row.amount != null ? row.amount : expected), expectedAmount: expected, ref: row.ref,
    payTo: cfg.upiId, payee: cfg.upiName, link, qr: await upi.qrSvg(link),
    expiresAt: row.expires_at, createdAt: row.created_at, serverTime: new Date().toISOString(), status: 'pending'
  };
}

async function createRecharge(user, input, cfg) {
  cfg = cfg || shop.config();
  const amount = rechargeAmount(input && input.amount);
  for (let attempt = 0; ; attempt++) {
    try {
      const row = first(await rpc(cfg, 'create_upi_recharge', { p_user: user.id, p_amount: amount, p_ref: upi.newRef(), p_minutes: cfg.qrMinutes }));
      return await checkout(Object.assign({ amount }, row), cfg);
    } catch (e) {
      const why = e.db || '';
      if (/duplicate|unique/i.test(why) && attempt < 2) continue;          // reference collision: new reference
      if (/TOO_MANY_OPEN/.test(why)) throw new ShopError('You have 5 unpaid payment QRs open. Pay one of them, or wait 10 minutes.', 429);
      if (/NO_FREE_AMOUNT/.test(why)) throw new ShopError('Lots of people are adding exactly ₹' + amount + ' right now. Try a slightly different amount.', 409);
      throw e;
    }
  }
}

async function findRecharge(user, id, cfg) {
  const n = parseInt(id, 10);
  if (!(n > 0)) throw new ShopError('Unknown payment.');
  const rows = await sb(cfg, '/rest/v1/recharges?select=id,amount,expected_amount,ref,status,created_at,expires_at,credited,utr,bank,utr_tries' +
    '&id=eq.' + n + '&user_id=eq.' + q(user.id));
  if (!rows || !rows[0]) throw new ShopError('Payment not found.', 404);
  return rows[0];
}

async function view(r, user, cfg) {
  const out = {
    id: r.id, amount: Number(r.amount), expectedAmount: Number(r.expected_amount), ref: r.ref, expiresAt: r.expires_at,
    serverTime: new Date().toISOString(), triesLeft: Math.max(0, 5 - (r.utr_tries || 0))
  };
  if (r.status === 'paid') {
    return Object.assign(out, { status: 'paid', credited: Number(r.credited), utr: r.utr, bank: r.bank, balance: await balanceOf(user, cfg) });
  }
  return Object.assign(out, { status: Date.now() > Date.parse(r.expires_at) ? 'expired' : 'pending' });
}

// Polled by the checkout every few seconds: checks the inbox (at most every few seconds overall) while the
// payment can still arrive, then reports pending / paid / expired.
async function rechargeStatus(user, id, cfg) {
  cfg = cfg || shop.config();
  let r = await findRecharge(user, id, cfg);
  if (r.status === 'pending' && Date.now() < Date.parse(r.expires_at) + GRACE_MS) {
    const s = await syncInbox(cfg).catch(() => null);
    if (s && s.credited) r = await findRecharge(user, id, cfg);
  }
  return view(r, user, cfg);
}

// "I've paid": the customer types the UTR from their UPI app. Only a genuine bank alert with that UTR counts.
async function claimUtr(user, id, utr, cfg) {
  cfg = cfg || shop.config();
  const clean = String(utr == null ? '' : utr).replace(/\D/g, '');
  if (clean.length !== 12) throw new ShopError('Enter the 12-digit UTR (UPI reference number) from your UPI app.');
  const r = await findRecharge(user, id, cfg);
  if (r.status === 'paid') return view(r, user, cfg);
  await syncInbox(cfg, { force: true }).catch(() => null);
  let res;
  try {
    res = await rpc(cfg, 'claim_upi_utr', { p_user: user.id, p_recharge: r.id, p_utr: clean });
  } catch (e) {
    if (/TOO_MANY_TRIES/.test(e.db || '')) throw new ShopError('Too many tries for this payment.' + (cfg.support ? ' Contact ' + cfg.support + ' with your UTR.' : ''), 429);
    if (/RECHARGE_NOT_FOUND/.test(e.db || '')) throw new ShopError('Payment not found.', 404);
    throw e;
  }
  if (res === 'used') throw new ShopError('That UTR has already been used for a top-up.', 409);
  if (res !== 'paid') {
    const left = Math.max(0, 4 - (r.utr_tries || 0));
    throw new ShopError('We haven’t received the bank’s confirmation for this UTR yet. It can take a few minutes: try again shortly.' +
      (left ? ' (' + left + (left === 1 ? ' try' : ' tries') + ' left)' : ''), 404, { triesLeft: left });
  }
  return view(await findRecharge(user, id, cfg), user, cfg);
}

/*
 * Read new bank alerts from the Gmail inbox and match them. Throttled in the database, so however many
 * customers are waiting, Gmail is checked at most once every 8 seconds (3 when a customer submits a UTR).
 */
async function syncInbox(cfg, opts) {
  cfg = cfg || shop.config();
  const state = first(await rpc(cfg, 'claim_upi_sync', { p_min_seconds: opts && opts.force ? 3 : 8 }));
  if (!state) return { skipped: true };
  let r;
  try {
    r = await upi.readInbox(cfg, state, opts && opts.deps);
  } catch (e) {
    const error = upi.describeError(e);
    await rpc(cfg, 'finish_upi_sync', { p_last_uid: null, p_uid_validity: null, p_error: error }).catch(() => {});
    return { error };
  }
  const credited = r.alerts.length ? Number(await rpc(cfg, 'ingest_upi_alerts', { p_alerts: r.alerts })) || 0 : 0;
  await rpc(cfg, 'finish_upi_sync', { p_last_uid: r.lastUid, p_uid_validity: r.uidValidity, p_error: null });
  return { credited, alerts: r.alerts.length, scanned: r.scanned, fromBanks: r.fromBanks, rejected: r.rejected };
}

// For /api/status: when the inbox was last read and whether it worked. No secrets.
async function inboxStatus(cfg, check) {
  cfg = cfg || shop.config();
  if (!(cfg.supabaseUrl && cfg.supabaseService)) return { checked: false, note: 'Supabase isn’t set up.' };
  const last = check && cfg.gmail && cfg.gmailPass ? await syncInbox(cfg, { force: true }).catch((e) => ({ error: e.message })) : null;
  const row = first(await sb(cfg, '/rest/v1/upi_sync?select=last_run,last_ok,last_error&id=eq.1'));
  return {
    gmail: cfg.gmail ? cfg.gmail.replace(/^(.).*?(.)?@/, (m, a, b) => a + '•••' + (b || '') + '@') : 'not set',
    lastChecked: row && Date.parse(row.last_run) > 0 ? row.last_run : null,
    lastWorked: row ? row.last_ok : null,
    lastError: row ? row.last_error : null,
    thisCheck: last
  };
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

module.exports = {
  sb, rpc, balanceOf,
  MIN_RECHARGE, currentUser, wallet, createRecharge, rechargeStatus, claimUtr, syncInbox, inboxStatus, placeOrder, orderStatus, rechargeAmount
};
