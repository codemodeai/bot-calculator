/*
 * UPI payments straight into the store's own account, verified from the bank's credit-alert emails.
 *
 *   1. A recharge gets a UPI link / QR for a unique amount (₹100 -> ₹100.37) with a reference note (tn).
 *   2. The customer pays with any UPI app. The money lands in your bank account; no gateway, no fee.
 *   3. Your bank emails a credit alert to the Gmail inbox in GMAIL_ADDRESS. We read it over IMAP (read-only),
 *      keep it only if it is genuine and pull out the amount, the 12-digit UTR and the note.
 *   4. The database matches it to the recharge (supabase/migrations/003_upi.sql) and credits the wallet.
 *
 * "Genuine" matters: anyone can email you a fake "Rs 100.37 credited" message. An alert only counts if
 *   - the From address is a bank domain (UPI_ALERT_SENDERS, default: Indian banks, including any *.bank.in), and
 *   - Gmail's own Authentication-Results header (the top one, added when Gmail received the email) says the
 *     bank's DKIM signature or DMARC passed for that same domain, and
 *   - it reads as a credit (not a debit) with an amount and a UTR.
 */
'use strict';

const crypto = require('crypto');

const REF_PREFIX = 'BST';
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';           // no 0/O, 1/I: easy to read back
const REF_RE = new RegExp('\\b(' + REF_PREFIX + '[' + REF_CHARS + ']{8})\\b', 'i');

// Banks' alert domains. Any *.bank.in domain is a bank: only RBI-regulated banks can register one.
const DEFAULT_SENDERS = [
  'bank.in', 'hdfcbank.net', 'hdfcbank.com', 'icicibank.com', 'sbi.co.in', 'axisbank.com', 'kotak.com',
  'idfcfirstbank.com', 'indusind.com', 'yesbank.in', 'federalbank.co.in', 'bankofbaroda.com', 'bankofbaroda.co.in',
  'pnb.co.in', 'canarabank.com', 'unionbankofindia.co.in', 'aubank.in', 'rblbank.com', 'bandhanbank.com'
];
const BANK_NAMES = [
  [/hdfc/, 'HDFC Bank'], [/icici/, 'ICICI Bank'], [/(^|\.)sbi\./, 'SBI'], [/axis/, 'Axis Bank'], [/kotak/, 'Kotak'],
  [/idfc/, 'IDFC FIRST Bank'], [/indusind/, 'IndusInd Bank'], [/yes/, 'Yes Bank'], [/federal/, 'Federal Bank'],
  [/baroda|bob/, 'Bank of Baroda'], [/pnb/, 'PNB'], [/canara/, 'Canara Bank'], [/union/, 'Union Bank'],
  [/(^|\.)au(bank)?\./, 'AU Bank'], [/rbl/, 'RBL Bank'], [/bandhan/, 'Bandhan Bank']
];

const VPA_RE = /^[a-z0-9._-]{2,256}@[a-z][a-z0-9.-]{1,64}$/i;

// ---------- payment link + QR ----------

function newRef() {
  let s = REF_PREFIX;
  for (let i = 0; i < 8; i++) s += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
  return s;
}

// NPCI UPI deep link. The amount is fixed (am), the note (tn) is our reference.
function payLink(o) {
  const enc = (v) => encodeURIComponent(String(v)).replace(/%40/g, '@');
  return 'upi://pay?pa=' + enc(o.vpa) + '&pn=' + enc(o.name) + '&am=' + Number(o.amount).toFixed(2) + '&cu=INR&tn=' + enc(o.ref);
}

async function qrSvg(text) {
  const QR = require('qrcode');
  // High error correction so the logo in the middle of the QR doesn't stop it scanning.
  return QR.toString(text, { type: 'svg', errorCorrectionLevel: 'H', margin: 0, color: { dark: '#0f172aff', light: '#ffffffff' } });
}

// ---------- reading a bank alert ----------

function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ').replace(/&#8377;|&#x20b9;/gi, '₹').replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'");
}

const MONEY = '(?:₹|Rs\\.?|INR)\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)';
const AMOUNT_PATTERNS = [
  new RegExp(MONEY + '\\s*(?:has\\s+been|have\\s+been|is|was)?\\s*(?:credited|received|deposited)', 'i'),          // Rs.100.37 has been credited
  new RegExp('(?:credited|received|deposited)\\s*(?:with|by|for|of)?\\s*(?:an?\\s+amount\\s+of\\s*)?' + MONEY, 'i'), // credited with INR 100.37
  new RegExp('\\bamount\\s*(?:\\(\\s*(?:Rs\\.?|INR|₹)\\s*\\))?\\s*[:\\-]?\\s*(?:₹|Rs\\.?|INR)?\\s*([0-9][0-9,]*(?:\\.[0-9]{1,2})?)', 'i')
];
// Last resort: the first amount within 60 characters after "credited", unless it's a balance.
const NEAR_CREDIT = new RegExp('(?:credited|received|deposited)([\\s\\S]{0,60}?)' + MONEY, 'i');

const UTR_PATTERNS = [
  /\b(?:UTR|RRN|UPI\s*Ref(?:erence)?|Ref(?:erence)?|Transaction\s*(?:ID|Ref(?:erence)?))\s*(?:No\.?|Number|Num|ID|#)?\s*(?:\(\s*(?:RRN|UTR)\s*\))?\s*(?:is|:|-|=|#)?\s*:?\s*(\d{12})(?!\d)/i,
  /\bUPI\s*[/:-]\s*(?:[A-Z0-9]{2,4}\s*[/:-]\s*)?(\d{12})(?!\d)/i                                                 // UPI/P2A/123456789012/NAME
];

function money(s) {
  const n = Number(String(s).replace(/,/g, ''));
  return isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : 0;
}

/*
 * Pull { amount, utr, ref, payer } out of a credit alert's subject + text, or return null if it isn't a UPI
 * credit (debits, OTPs, statements and newsletters all return null).
 */
function parseAlert(subject, body, opts) {
  opts = opts || {};
  const text = (String(subject || '') + '\n' + String(body || '')).replace(/[ \t ]+/g, ' ');
  const credit = text.search(/\b(credited|received|deposited)\b/i);
  const debit = text.search(/\b(debited|withdrawn|spent|sent to|paid to|transferred to)\b/i);
  if (credit < 0 || (debit >= 0 && debit < credit)) return null;

  let amount = 0;
  for (const re of AMOUNT_PATTERNS) {
    const m = text.match(re);
    if (m && (amount = money(m[1]))) break;
  }
  if (!amount) {
    const m = text.match(NEAR_CREDIT);
    if (m && !/bal/i.test(m[1].slice(-15))) amount = money(m[2]);
  }

  let utr = '';
  for (const re of UTR_PATTERNS) {
    const m = text.match(re);
    if (m) { utr = m[1]; break; }
  }
  if (!utr) {
    const all = text.match(/(?<![\d*Xx])\d{12}(?!\d)/g) || [];
    if (new Set(all).size === 1) utr = all[0];
  }
  if (!amount || !utr) return null;

  const refMatch = text.match(REF_RE);
  const own = String(opts.ownVpa || '').toLowerCase();
  const payer = (text.match(/[a-z0-9._-]{2,64}@[a-z][a-z0-9-]{1,40}(?![a-z0-9.-])/gi) || [])
    .find((v) => v.toLowerCase() !== own) || '';
  return { amount, utr, ref: refMatch ? refMatch[1].toUpperCase() : '', payer };
}

// ---------- is the email really from the bank? ----------

function domainOf(address) {
  const m = String(address || '').trim().toLowerCase().match(/@([a-z0-9.-]+)$/);
  return m ? m[1].replace(/\.$/, '') : '';
}

function senderList(value) {
  const list = String(value || '').split(/[\s,]+/).map((s) => s.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  return list.length ? list : DEFAULT_SENDERS;
}

// A full address (alerts@hdfcbank.net) must match exactly; a domain also covers its subdomains.
function allowedSender(address, list) {
  const addr = String(address || '').trim().toLowerCase();
  const dom = domainOf(addr);
  if (!dom) return false;
  return list.some((e) => (e.includes('@') ? addr === e : dom === e || dom.endsWith('.' + e)));
}

// Header block of a raw email, with folded lines joined.
function headerLines(raw) {
  const s = Buffer.isBuffer(raw) ? raw.toString('latin1') : String(raw || '');
  const end = s.search(/\r?\n\r?\n/);
  return (end < 0 ? s : s.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/);
}

function parseAuthResults(value) {
  const parts = String(value || '').replace(/\([^()]*\)/g, ' ').split(';').map((p) => p.trim()).filter(Boolean);
  const server = (parts.shift() || '').split(/\s+/)[0].toLowerCase();
  const results = parts.map((p) => {
    const m = p.match(/^([a-z0-9_-]+)\s*=\s*([a-z0-9_-]+)(.*)$/i);
    if (!m) return null;
    const props = {};
    (m[3].match(/[a-z0-9_.-]+=[^\s;]+/gi) || []).forEach((kv) => {
      const i = kv.indexOf('=');
      props[kv.slice(0, i).toLowerCase()] = kv.slice(i + 1).replace(/^"|"$/g, '').toLowerCase();
    });
    return { method: m[1].toLowerCase(), result: m[2].toLowerCase(), props };
  }).filter(Boolean);
  return { server, results };
}

const aligned = (d, from) => !!d && (d === from || from.endsWith('.' + d) || d.endsWith('.' + from));

/*
 * Trust check on a raw email: one From address, on the bank list, and Gmail's top Authentication-Results says
 * DMARC passed for that domain or an aligned DKIM signature passed. Gmail adds its header above any the sender
 * put in the message, so only the first one counts.
 */
function verifySender(raw, list, authServer) {
  const lines = headerLines(raw);
  const froms = lines.filter((l) => /^from\s*:/i.test(l));
  if (froms.length !== 1) return { ok: false, reason: 'needs exactly one From header' };
  const addrs = froms[0].replace(/^from\s*:/i, '').match(/[^\s<>"',;:]+@[^\s<>"',;:]+/g) || [];
  if (addrs.length !== 1) return { ok: false, reason: 'needs exactly one From address' };
  const address = addrs[0].toLowerCase(), from = domainOf(address);
  if (!allowedSender(address, list)) return { ok: false, reason: 'sender is not on the bank list', domain: from };
  const ar = lines.find((l) => /^authentication-results\s*:/i.test(l));
  if (!ar) return { ok: false, reason: 'no Authentication-Results header', domain: from };
  const { server, results } = parseAuthResults(ar.replace(/^authentication-results\s*:/i, ''));
  if (server !== (authServer || 'mx.google.com')) return { ok: false, reason: 'not checked by Gmail', domain: from };
  const dmarc = results.some((r) => r.method === 'dmarc' && r.result === 'pass' && r.props['header.from'] === from);
  const dkim = results.some((r) => r.method === 'dkim' && r.result === 'pass' &&
    aligned(r.props['header.d'] || domainOf(r.props['header.i']), from));
  return dmarc || dkim ? { ok: true, domain: from, address } : { ok: false, reason: 'DKIM/DMARC did not pass', domain: from };
}

function bankName(domain) {
  const d = String(domain || '').toLowerCase();
  const hit = BANK_NAMES.find(([re]) => re.test(d));
  return hit ? hit[1] : d;
}

// One raw email -> an alert row for ingest_upi_alerts, or null.
async function toAlert(raw, receivedAt, cfg) {
  const sender = verifySender(raw, senderList(cfg.alertSenders), cfg.authServer);
  if (!sender.ok) return null;
  const { simpleParser } = require('mailparser');
  const mail = await simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const info = parseAlert(mail.subject, mail.text || htmlToText(mail.html), { ownVpa: cfg.upiId });
  if (!info) return null;
  return {
    utr: info.utr, amount: info.amount.toFixed(2), bank: bankName(sender.domain), payer: info.payer, ref: info.ref,
    received_at: new Date(receivedAt || Date.now()).toISOString()
  };
}

// ---------- Gmail inbox (IMAP, read-only) ----------

const MAX_PER_RUN = 150;

function withTimeout(promise, ms, onTimeout) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => { t = setTimeout(() => { onTimeout(); reject(Object.assign(new Error('Gmail took too long to answer'), { code: 'TIMEOUT' })); }, ms); })
  ]);
}

/*
 * New messages since the last run (state = { last_uid, uid_validity } from upi_sync); the first run looks
 * back two days. Only messages from bank domains are downloaded. Nothing in the mailbox is changed.
 */
async function readInbox(cfg, state, deps) {
  const { ImapFlow } = (deps && deps.imapflow) || require('imapflow');
  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: cfg.gmail, pass: String(cfg.gmailPass || '').replace(/\s+/g, '') },
    logger: false, connectionTimeout: 8000, greetingTimeout: 6000, socketTimeout: 15000, disableAutoIdle: true
  });
  const list = senderList(cfg.alertSenders);
  const run = async () => {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX', { readOnly: true });
    const out = { alerts: [], scanned: 0, fromBanks: 0, rejected: 0 };
    try {
      const box = client.mailbox;
      const uidValidity = Number(box.uidValidity);
      const last = Number(state && state.last_uid) || 0;
      const fresh = !last || Number(state && state.uid_validity) !== uidValidity;
      let uids = fresh
        ? await client.search({ since: new Date(Date.now() - 2 * 86400e3) }, { uid: true })
        : await client.search({ uid: (last + 1) + ':*' }, { uid: true });
      uids = (uids || []).map(Number).filter((u) => fresh || u > last).sort((a, b) => a - b);
      out.uidValidity = uidValidity;
      out.lastUid = uids.length ? uids[uids.length - 1] : fresh ? Math.max(0, Number(box.uidNext) - 1) : last;
      const recent = uids.slice(-MAX_PER_RUN);
      out.scanned = recent.length;
      const banks = [];
      if (recent.length) {
        for await (const m of client.fetch(recent, { uid: true, envelope: true }, { uid: true })) {
          const from = m.envelope && m.envelope.from && m.envelope.from[0];
          if (from && allowedSender(from.address, list)) banks.push(m.uid);
        }
      }
      out.fromBanks = banks.length;
      if (banks.length) {
        for await (const m of client.fetch(banks, { uid: true, source: true, internalDate: true }, { uid: true })) {
          const a = m.source ? await toAlert(m.source, m.internalDate, cfg) : null;
          if (a) out.alerts.push(a); else out.rejected++;
        }
      }
    } finally {
      lock.release();
    }
    await client.logout().catch(() => {});
    return out;
  };
  try {
    return await withTimeout(run(), 7000, () => { try { client.close(); } catch (e) { /* already closed */ } });
  } catch (e) {
    try { client.close(); } catch (x) { /* already closed */ }
    throw e;
  }
}

// A short, secret-free reason for /api/status.
function describeError(e) {
  const s = String((e && (e.responseText || e.message)) || e || '');
  if (/AUTHENTICATIONFAILED|Invalid credentials|authenticat/i.test(s) || (e && e.authenticationFailed)) {
    return 'Gmail rejected the login: use a 16-character App Password (Google Account → Security → App passwords).';
  }
  if (/TIMEOUT|too long/i.test(s)) return 'Gmail took too long to answer.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i.test(s)) return 'Couldn’t connect to Gmail.';
  return 'Couldn’t read the inbox: ' + s.replace(/[^\w .:,'-]/g, '').slice(0, 120);
}

module.exports = {
  REF_RE, DEFAULT_SENDERS, VPA_RE, newRef, payLink, qrSvg, parseAlert, htmlToText, verifySender, parseAuthResults,
  allowedSender, senderList, bankName, toAlert, readInbox, describeError
};
