/*
 * Server-side store logic shared by the /api functions (Vercel) and dev-server.js.
 *
 * Money flow:  customer adds money to a wallet by UPI, straight into your bank account (lib/upi.js)  ->
 *              orders are paid from the wallet at the exact price  ->  we place them on the SMM panel.
 * Wallet code lives in lib/wallet.js; this file has prices and the panel.
 *
 * All secrets come from environment variables, never from the browser:
 *   SMM_API_URL              panel API endpoint (default https://smmzio.com/api/v2)
 *   SMM_API_KEY              panel API key
 *   UPI_ID, UPI_NAME         where customers pay (your UPI ID) and the name their UPI app shows
 *   GMAIL_ADDRESS            the Gmail inbox that gets your bank's UPI credit alerts
 *   GMAIL_APP_PASSWORD       a Google App Password for it (read-only IMAP access)
 *   UPI_ALERT_SENDERS        optional: your bank's alert domain or address (default: common Indian banks)
 *   UPI_QR_MINUTES           how long a payment QR stays valid (default 10)
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY   customer logins and wallets
 *   MARKUP_PERCENT           your margin on top of the panel price (default 80; 0 sells at panel price)
 *   ROUND_PRICES             round selling prices up to tidy numbers, e.g. ₹0.288 -> ₹0.30 (default on; 0 = off)
 *   PANEL_TO_INR_RATE        only if your panel account isn't in INR, e.g. 84 for USD
 *   STORE_NAME, SUPPORT_CONTACT   shown in the store
 */
'use strict';

const C = require('../calculator');
const upi = require('./upi');
const bundled = require('../data/services.json');

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);

function config() {
  return {
    smmUrl: env('SMM_API_URL', 'https://smmzio.com/api/v2'),
    smmKey: env('SMM_API_KEY', ''),
    supabaseUrl: env('SUPABASE_URL', '').replace(/\/+$/, ''),
    supabaseAnon: env('SUPABASE_ANON_KEY', ''),
    supabaseService: env('SUPABASE_SERVICE_ROLE_KEY', ''),
    upiId: env('UPI_ID', '').trim(),
    upiName: env('UPI_NAME', env('STORE_NAME', 'Boostly')),
    gmail: env('GMAIL_ADDRESS', '').trim(),
    gmailPass: env('GMAIL_APP_PASSWORD', ''),
    alertSenders: env('UPI_ALERT_SENDERS', ''),
    qrMinutes: Math.min(30, Math.max(3, parseInt(env('UPI_QR_MINUTES', 10), 10) || 10)),
    markup: Number(env('MARKUP_PERCENT', 80)) || 0,
    roundPrices: env('ROUND_PRICES', '1') !== '0',
    fx: Number(env('PANEL_TO_INR_RATE', 0)) || 0,
    storeName: env('STORE_NAME', 'Boostly'),
    support: env('SUPPORT_CONTACT', '')
  };
}

// "live" takes real money and places real orders; "demo" never does either.
function mode(cfg) {
  cfg = cfg || config();
  return cfg.smmKey && cfg.supabaseUrl && cfg.supabaseAnon && cfg.supabaseService &&
    upi.VPA_RE.test(cfg.upiId || '') && cfg.gmail && cfg.gmailPass ? 'live' : 'demo';
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
    let body = null;
    if (text) { try { body = JSON.parse(text); } catch (e) { body = { error: 'Non-JSON response (' + res.status + ')' }; } }
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

// Selling rate per 1000: panel price + markup, rounded up to a tidy number unless ROUND_PRICES=0.
function sellRate(cost, cfg) {
  const r = C.retailRate(cost, cfg.markup);
  return cfg.roundPrices ? C.niceRate(r) : r;
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
      rate: sellRate(s.rate, cfg), min: s.min, max: s.max, refill: s.refill, dripfeed: false
    }))
  };
}

// Setup check for the store owner: which keys are set and whether the panel answers. No secrets or balance.
async function status(cfg) {
  cfg = cfg || config();
  const out = {
    mode: mode(cfg),
    keys: {
      SMM_API_KEY: !!cfg.smmKey, UPI_ID: !!cfg.upiId, GMAIL_ADDRESS: !!cfg.gmail, GMAIL_APP_PASSWORD: !!cfg.gmailPass,
      SUPABASE_URL: !!cfg.supabaseUrl, SUPABASE_ANON_KEY: !!cfg.supabaseAnon, SUPABASE_SERVICE_ROLE_KEY: !!cfg.supabaseService
    },
    upi: {
      payTo: cfg.upiId ? (upi.VPA_RE.test(cfg.upiId) ? cfg.upiId : 'UPI_ID doesn’t look like a UPI ID (name@bank)') : 'not set',
      payeeName: cfg.upiName,
      qrMinutes: cfg.qrMinutes,
      trustedAlertSenders: upi.senderList(cfg.alertSenders).join(', ')
    },
    markupPercent: cfg.markup,
    roundPrices: cfg.roundPrices,
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
  const rate = sellRate(svc.rate, cfg);
  const charge = C.exactCharge(rate, quantity);           // exact wallet price, no ₹1 minimum
  const cost = C.exactCharge(svc.rate, quantity);
  const title = quantity.toLocaleString('en-IN') + ' ' + svc.platform + ' ' + svc.kind;
  return { service: svc, quantity, link, charge, cost, title };
}

module.exports = {
  config, mode, status, sellRate, ShopError, smm, fetchJson, catalogue, costList, priceOrder, cleanLink,
  _resetCache: () => { cache = null; }
};
