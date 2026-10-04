/*
 * Server-side store logic shared by the /api functions (Vercel) and dev-server.js.
 *
 * Money flow:  customer pays us through Razorpay  ->  we verify the payment  ->
 *              we place the order on the SMM panel with our panel API key (paid from the panel balance).
 *
 * All secrets come from environment variables, never from the browser:
 *   SMM_API_URL              panel API endpoint (default https://smmorange.com/api/v2)
 *   SMM_API_KEY              panel API key
 *   RAZORPAY_KEY_ID          rzp_live_... / rzp_test_...
 *   RAZORPAY_KEY_SECRET      Razorpay key secret
 *   RAZORPAY_WEBHOOK_SECRET  optional, enables /api/webhook
 *   MARKUP_PERCENT           your margin on top of the panel price (default 50; 0 sells at panel price)
 *   PANEL_TO_INR_RATE        only if your panel account isn't in INR, e.g. 84 for USD
 *   STORE_NAME, SUPPORT_CONTACT   shown in the store
 */
'use strict';

const crypto = require('crypto');
const C = require('../calculator');
const bundled = require('../data/services.json');

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);

function config() {
  return {
    smmUrl: env('SMM_API_URL', 'https://smmorange.com/api/v2'),
    smmKey: env('SMM_API_KEY', ''),
    keyId: env('RAZORPAY_KEY_ID', ''),
    keySecret: env('RAZORPAY_KEY_SECRET', ''),
    webhookSecret: env('RAZORPAY_WEBHOOK_SECRET', ''),
    markup: Number(env('MARKUP_PERCENT', 50)) || 0,
    fx: Number(env('PANEL_TO_INR_RATE', 0)) || 0,
    storeName: env('STORE_NAME', 'Boostly'),
    support: env('SUPPORT_CONTACT', '')
  };
}

// "live" takes real money and places real orders; "demo" never does either.
function mode(cfg) {
  cfg = cfg || config();
  return cfg.keyId && cfg.keySecret && cfg.smmKey ? 'live' : 'demo';
}

class ShopError extends Error {
  constructor(message, status, extra) { super(message); this.status = status || 400; this.extra = extra || {}; }
}

// ---------- HTTP helpers ----------

async function fetchJson(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, Object.assign({}, init, { signal: ctl.signal }));
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = { error: 'Non-JSON response (' + res.status + ')' }; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

// ---------- SMM panel (Perfect Panel API v2) ----------

async function smm(params, cfg) {
  cfg = cfg || config();
  if (!cfg.smmKey) throw new ShopError('SMM_API_KEY is not set.', 500);
  const form = new URLSearchParams(Object.assign({ key: cfg.smmKey }, params));
  return (await fetchJson(cfg.smmUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bot-calculator-store/1.0' },
    body: form.toString()
  })).body;
}

// ---------- Razorpay ----------

async function rzp(method, path, body, cfg) {
  cfg = cfg || config();
  const r = await fetchJson('https://api.razorpay.com/v1' + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(cfg.keyId + ':' + cfg.keySecret).toString('base64'),
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (r.status >= 400) {
    const msg = (r.body && r.body.error && r.body.error.description) || 'Razorpay error ' + r.status;
    throw new ShopError(msg, 502);
  }
  return r.body;
}

function safeEqualHex(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// Checkout handler signature: HMAC_SHA256(order_id + "|" + payment_id, key_secret)
function verifyCheckoutSignature(orderId, paymentId, signature, secret) {
  return !!(orderId && paymentId && signature && secret) && safeEqualHex(hmac(secret, orderId + '|' + paymentId), signature);
}

// Webhook signature: HMAC_SHA256(raw request body, webhook_secret)
function verifyWebhookSignature(rawBody, signature, secret) {
  return !!(signature && secret) && safeEqualHex(hmac(secret, rawBody), signature);
}

// ---------- catalogue ----------

let cache = null;            // { at, list, source, currency, fx }
const CACHE_MS = 5 * 60 * 1000;

// Services we can't sell through a link + quantity form (custom comment text needs a separate field).
function sellable(s) {
  return s.platform !== 'Other' && !/\bcustom\b/i.test(C.plain(s.name)) && s.rate > 0 && s.min > 0;
}

function prepare(rawList, currency, fx) {
  return rawList.map((r) => C.normaliseService(r, currency))
    .filter((s) => s.id && isFinite(s.rate))
    .map((s) => Object.assign(s, {
      rate: C.round(s.rate * (fx || 1), 6),            // always INR from here on
      currency: 'INR',
      platform: C.platformOf(s),
      kind: C.serviceType(s)
    }))
    .filter(sellable);
}

function panelError(r) {
  return r && !Array.isArray(r) && r.error ? String(r.error) : null;
}

/*
 * Panel cost prices in INR.
 * With SMM_API_KEY set, they always come live from the panel (cached 5 minutes). If the panel can't be
 * reached, the last live list is reused; with no live list at all the store refuses to quote rather than
 * sell at outdated prices. Without a key (demo mode) the bundled sample list is used.
 */
async function costList(cfg) {
  cfg = cfg || config();
  if (!cfg.smmKey) {
    if (!cache || cache.source !== 'sample') {
      cache = { at: Date.now(), list: prepare(bundled.services, 'INR', 1), source: 'sample', currency: 'INR', fx: 1, fetchedAt: bundled.fetchedAt };
    }
    return cache;
  }
  if (cache && cache.source === 'live' && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const [live, bal] = await Promise.all([smm({ action: 'services' }, cfg), smm({ action: 'balance' }, cfg).catch(() => null)]);
    const err = panelError(live);
    if (err) throw new ShopError('The panel said: ' + err, 502);
    if (!Array.isArray(live) || !live.length) throw new ShopError('The panel returned no services.', 502);
    const currency = String((bal && bal.currency) || 'INR').toUpperCase();
    let fx = 1;
    if (currency !== 'INR') {
      if (!cfg.fx) throw new ShopError('Your panel account is in ' + currency + '. Set PANEL_TO_INR_RATE (rupees per 1 ' + currency + ').', 500);
      fx = cfg.fx;
    }
    cache = { at: Date.now(), list: prepare(live, currency, fx), source: 'live', currency, fx, fetchedAt: new Date().toISOString() };
    return cache;
  } catch (e) {
    if (cache && cache.source === 'live' && Date.now() - cache.at < 60 * 60 * 1000) return Object.assign({}, cache, { stale: true });
    if (e instanceof ShopError) throw e;
    throw new ShopError('Couldn’t reach the panel to load prices. Try again in a minute.', 502);
  }
}

// What customers see: selling rate per 1000 (markup applied). Cost rates never leave the server.
async function catalogue(cfg) {
  cfg = cfg || config();
  const c = await costList(cfg);
  return {
    source: c.source,
    fetchedAt: c.fetchedAt,
    stale: !!c.stale,
    services: c.list.map((s) => ({
      id: s.id, name: s.name, category: s.category, platform: s.platform, kind: s.kind,
      rate: C.retailRate(s.rate, cfg.markup), min: s.min, max: s.max, refill: s.refill, dripfeed: false
    }))
  };
}

// Setup check for the store owner: which keys are set and whether the panel answers. No secrets or balance.
async function status(cfg) {
  cfg = cfg || config();
  const out = {
    mode: mode(cfg),
    keys: { SMM_API_KEY: !!cfg.smmKey, RAZORPAY_KEY_ID: !!cfg.keyId, RAZORPAY_KEY_SECRET: !!cfg.keySecret, RAZORPAY_WEBHOOK_SECRET: !!cfg.webhookSecret },
    razorpay: cfg.keyId ? (/^rzp_live_/.test(cfg.keyId) ? 'live keys' : /^rzp_test_/.test(cfg.keyId) ? 'test keys' : 'unrecognised key id') : 'not set',
    markupPercent: cfg.markup,
    panel: { url: cfg.smmUrl }
  };
  try {
    const c = await costList(cfg);
    Object.assign(out.panel, { ok: true, prices: c.source === 'live' ? 'live from your panel' : 'sample list (no SMM_API_KEY)', currency: c.currency, services: c.list.length, fetchedAt: c.fetchedAt, stale: !!c.stale });
  } catch (e) {
    Object.assign(out.panel, { ok: false, error: e.message });
  }
  return out;
}

// ---------- order validation ----------

function cleanLink(link) {
  const s = String(link == null ? '' : link).trim();
  if (!s) throw new ShopError('Enter your profile or post link.');
  if (s.length > 250) throw new ShopError('That link is too long.');
  if (/\s/.test(s)) throw new ShopError('The link can’t contain spaces.');
  if (/^https?:\/\/[^/\s]+\.[^/\s]+/i.test(s)) return s;
  if (/^@?[A-Za-z0-9._]{1,60}$/.test(s)) return s.replace(/^@/, '');
  if (/^(www\.)?[a-z0-9-]+\.[a-z]{2,}\//i.test(s)) return 'https://' + s;
  throw new ShopError('Enter a full link (https://…) or a username.');
}

async function priceOrder(input, cfg) {
  cfg = cfg || config();
  const { list } = await costList(cfg);
  const svc = list.find((s) => s.id === String(input.serviceId));
  if (!svc) throw new ShopError('That service isn’t available any more. Refresh the page.');
  const quantity = parseInt(input.quantity, 10);
  if (!(quantity > 0)) throw new ShopError('Enter a quantity.');
  if (quantity < svc.min) throw new ShopError('Minimum order is ' + svc.min + '.');
  if (svc.max > 0 && quantity > svc.max) throw new ShopError('Maximum order is ' + svc.max + '.');
  const link = cleanLink(input.link);
  const rate = C.retailRate(svc.rate, cfg.markup);
  const amount = C.chargeAmount(rate, quantity);          // rupees, rounded up to the paisa, min ₹1
  return { service: svc, quantity, link, amount, amountPaise: Math.round(amount * 100), currency: 'INR' };
}

// ---------- order lifecycle ----------

function demoId(prefix) { return prefix + '_' + crypto.randomBytes(8).toString('hex'); }

async function createOrder(input, cfg) {
  cfg = cfg || config();
  const p = await priceOrder(input, cfg);
  const title = p.quantity.toLocaleString('en-IN') + ' ' + p.service.platform + ' ' + p.service.kind;
  if (mode(cfg) !== 'live') {
    return { demo: true, orderId: demoId('demo_order'), amount: p.amountPaise, currency: p.currency, title, storeName: cfg.storeName };
  }
  const order = await rzp('POST', '/orders', {
    amount: p.amountPaise,
    currency: p.currency,
    receipt: 'boost_' + Date.now().toString(36),
    notes: { service: p.service.id, link: p.link, quantity: String(p.quantity), title, email: String(input.email || '').slice(0, 120) }
  }, cfg);
  return { demo: false, orderId: order.id, amount: order.amount, currency: order.currency, keyId: cfg.keyId, title, storeName: cfg.storeName };
}

/*
 * Turn a captured payment into a panel order, at most once.
 * The payment's notes are the record: smm_order once placed, smm_error if the panel refused.
 * Order details come from the Razorpay order we created (never from the browser).
 */
async function fulfil(paymentId, cfg) {
  cfg = cfg || config();
  let pay = await rzp('GET', '/payments/' + encodeURIComponent(paymentId), null, cfg);
  const notes = pay.notes && !Array.isArray(pay.notes) ? pay.notes : {};
  if (notes.smm_order) return { trackingId: pay.id, smmOrder: notes.smm_order, already: true };
  if (notes.smm_unknown) throw new ShopError('We’re checking this order manually.', 502, { trackingId: pay.id });

  if (pay.status === 'authorized') {
    pay = await rzp('POST', '/payments/' + pay.id + '/capture', { amount: pay.amount, currency: pay.currency }, cfg);
  }
  if (pay.status !== 'captured') throw new ShopError('Payment is ' + pay.status + ', not completed.', 402);

  const order = await rzp('GET', '/orders/' + pay.order_id, null, cfg);
  const n = order.notes || {};
  if (!n.service || !n.link || !n.quantity) throw new ShopError('This payment isn’t for a store order.', 400);
  if (order.amount !== pay.amount) throw new ShopError('Amount mismatch.', 400);

  const setNotes = (extra) => rzp('PATCH', '/payments/' + pay.id, { notes: Object.assign({}, notes, extra) }, cfg).catch(() => {});

  let r;
  try {
    r = await smm({ action: 'add', service: n.service, link: n.link, quantity: n.quantity }, cfg);
  } catch (e) {
    // Timed out: the panel may or may not have placed it, so don't retry automatically.
    await setNotes({ smm_unknown: new Date().toISOString() });
    throw new ShopError('The panel didn’t answer. We’ll check your order manually.', 502, { trackingId: pay.id });
  }
  if (!r || r.order == null) {
    const err = String((r && r.error) || 'Unknown panel error').slice(0, 200);
    await setNotes({ smm_error: err });
    throw new ShopError('Payment received, but the order couldn’t be placed: ' + err, 502, { trackingId: pay.id });
  }
  await setNotes({ smm_order: String(r.order), smm_error: '' });
  return { trackingId: pay.id, smmOrder: String(r.order), already: false };
}

async function verifyAndFulfil(body, cfg) {
  cfg = cfg || config();
  if (body && body.demo) {
    if (mode(cfg) === 'live') throw new ShopError('Demo payments are off.', 400);
    return { demo: true, trackingId: demoId('demo'), smmOrder: null };
  }
  const { razorpay_order_id: o, razorpay_payment_id: p, razorpay_signature: sig } = body || {};
  if (!verifyCheckoutSignature(o, p, sig, cfg.keySecret)) throw new ShopError('Payment signature check failed.', 400);
  return fulfil(p, cfg);
}

const STATUS_LABEL = {
  pending: 'Queued', 'in progress': 'In progress', processing: 'In progress', completed: 'Completed',
  partial: 'Partially delivered', canceled: 'Canceled', cancelled: 'Canceled'
};

async function orderStatus(trackingId, cfg) {
  cfg = cfg || config();
  const id = String(trackingId || '').trim();
  if (/^demo_/.test(id)) {
    return { trackingId: id, demo: true, status: 'In progress', state: 'progress', startCount: 1200, remains: 400, quantity: 1000, title: 'Demo order' };
  }
  if (!/^pay_[A-Za-z0-9]{6,30}$/.test(id)) throw new ShopError('Tracking IDs look like pay_XXXXXXXX.');
  if (mode(cfg) !== 'live') throw new ShopError('The store isn’t connected to Razorpay yet.', 503);
  const pay = await rzp('GET', '/payments/' + id, null, cfg);
  const order = pay.order_id ? await rzp('GET', '/orders/' + pay.order_id, null, cfg) : { notes: {} };
  const notes = pay.notes && !Array.isArray(pay.notes) ? pay.notes : {};
  const n = order.notes || {};
  const base = {
    trackingId: id, title: n.title || 'Order', quantity: Number(n.quantity) || null,
    link: n.link || '', paid: pay.amount / 100, currency: pay.currency, createdAt: pay.created_at
  };
  if (!notes.smm_order) {
    const failed = notes.smm_error || notes.smm_unknown;
    return Object.assign(base, {
      status: failed ? 'Needs attention' : pay.status === 'captured' ? 'Processing payment' : 'Payment ' + pay.status,
      state: failed ? 'error' : 'pending', note: failed ? 'Contact support with this tracking ID.' : ''
    });
  }
  const s = await smm({ action: 'status', order: notes.smm_order }, cfg);
  const raw = String((s && s.status) || 'pending').toLowerCase();
  const label = STATUS_LABEL[raw] || (s && s.status) || 'Queued';
  return Object.assign(base, {
    smmOrder: notes.smm_order,
    status: label,
    state: /complete/.test(raw) ? 'done' : /cancel/.test(raw) ? 'error' : /partial/.test(raw) ? 'partial' : /progress|processing/.test(raw) ? 'progress' : 'pending',
    startCount: s && s.start_count != null ? Number(s.start_count) : null,
    remains: s && s.remains != null ? Number(s.remains) : null
  });
}

module.exports = {
  config, mode, status, ShopError, smm, rzp, catalogue, costList, priceOrder, cleanLink,
  createOrder, fulfil, verifyAndFulfil, orderStatus,
  verifyCheckoutSignature, verifyWebhookSignature, hmac,
  _resetCache: () => { cache = null; }
};
