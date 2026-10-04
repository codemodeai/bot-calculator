/*
 * Admin panel (/admin) and support tickets.
 *
 * Who is an admin: a signed-in user whose verified email is in the `admins` table (owner or staff), or in
 * ADMIN_EMAILS (always an owner). Every admin request re-checks this on the server; the admin page itself
 * holds no data. Owners can add and remove admins; staff can do everything else.
 */
'use strict';

const shop = require('./shop');
const wallet = require('./wallet');
const C = require('../calculator');
const { ShopError } = shop;
const { sb, rpc } = wallet;
const q = encodeURIComponent;

const TICKET_CATEGORIES = ['order', 'payment', 'account', 'other'];

async function roleOf(user, cfg) {
  if (!user || !user.verified || !user.email) return null;
  const email = user.email.toLowerCase();
  if ((cfg.adminEmails || []).includes(email)) return 'owner';
  const rows = await sb(cfg, '/rest/v1/admins?select=role&email=eq.' + q(email));
  return rows && rows[0] ? rows[0].role : null;
}

async function requireAdmin(req, cfg) {
  cfg = cfg || shop.config();
  const user = await wallet.currentUser(req, cfg);
  const role = await roleOf(user, cfg);
  if (!role) throw new ShopError('This page is only for the store team.', 403);
  return Object.assign(user, { role });
}

const num = (v) => Number(v) || 0;
const first = (rows) => (Array.isArray(rows) ? rows[0] : rows) || null;
const page = (v) => Math.max(0, parseInt(v, 10) || 0);
const orderById = async (cfg, id) => first(await sb(cfg, '/rest/v1/orders?select=id,title,link,quantity,charge,cost,status,smm_order,error,created_at&id=eq.' + (parseInt(id, 10) || 0)));

// Start of today / 7 / 30 / 90 days ago in India time, or the beginning of time.
function rangeStart(range) {
  const IST = 5.5 * 3600e3;
  const today = Math.floor((Date.now() + IST) / 86400e3) * 86400e3 - IST;
  const days = { today: 0, '7d': 6, '30d': 29, '90d': 89 }[range];
  return days == null ? new Date(0).toISOString() : new Date(today - days * 86400e3).toISOString();
}

// ---------- reads ----------

async function overview(cfg, range) {
  const r = ['today', '7d', '30d', '90d', 'all'].includes(range) ? range : '30d';
  const [stats, daily, recent, panel] = await Promise.all([
    rpc(cfg, 'admin_stats', { p_from: rangeStart(r) }),
    rpc(cfg, 'admin_daily', { p_days: r === '90d' || r === 'all' ? 90 : 30 }),
    rpc(cfg, 'admin_orders', { p_status: null, p_search: null, p_limit: 8, p_offset: 0 }),
    cfg.smmKey ? shop.smm({ action: 'balance' }, cfg).catch(() => null) : Promise.resolve(null)
  ]);
  const s = stats || {};
  const revenue = num(s.revenue), cost = num(s.provider_cost);
  let provider = null;
  if (panel && panel.balance != null) {
    const currency = String(panel.currency || 'INR').toUpperCase();
    const fx = currency === 'INR' ? 1 : cfg.fx || 0;
    provider = { balance: num(panel.balance), currency, inr: fx ? C.round(num(panel.balance) * fx, 2) : null };
  }
  return {
    range: r,
    stats: Object.assign({}, s, { profit: C.round(revenue - cost, 4), margin: revenue ? Math.round((revenue - cost) / revenue * 1000) / 10 : 0 }),
    daily: (daily || []).map((d) => ({ day: d.day, moneyIn: num(d.money_in), revenue: num(d.revenue), cost: num(d.cost), profit: C.round(num(d.revenue) - num(d.cost), 4), orders: num(d.orders) })),
    recent: recent || [],
    provider
  };
}

const orders = (cfg, p) => rpc(cfg, 'admin_orders', { p_status: p.status || null, p_search: (p.q || '').trim() || null, p_limit: 50, p_offset: page(p.page) * 50 });
const customers = (cfg, p) => rpc(cfg, 'admin_users', { p_search: (p.q || '').trim() || null, p_limit: 50, p_offset: page(p.page) * 50 });

async function payments(cfg, p) {
  const [list, unmatched, sync] = await Promise.all([
    rpc(cfg, 'admin_payments', { p_limit: 50, p_offset: page(p.page) * 50 }),
    sb(cfg, '/rest/v1/upi_alerts?select=utr,amount,bank,payer,ref,received_at&recharge_id=is.null&order=received_at.desc&limit=50'),
    sb(cfg, '/rest/v1/upi_sync?select=last_run,last_ok,last_error&id=eq.1')
  ]);
  return { payments: list || [], unmatched: unmatched || [], inbox: first(sync) };
}

async function tickets(cfg, p) {
  const st = ['open', 'answered', 'closed'].includes(p.status) ? '&status=eq.' + p.status : '';
  return sb(cfg, '/rest/v1/tickets?select=id,email,subject,category,order_id,status,last_from,created_at,updated_at&order=updated_at.desc&limit=100' + st);
}

async function ticket(cfg, id) {
  const n = parseInt(id, 10);
  const t = first(await sb(cfg, '/rest/v1/tickets?select=*&id=eq.' + n));
  if (!t) throw new ShopError('Ticket not found.', 404);
  const [messages, order] = await Promise.all([
    sb(cfg, '/rest/v1/ticket_messages?select=id,from_staff,author,body,created_at&order=id.asc&ticket_id=eq.' + n),
    t.order_id ? orderById(cfg, t.order_id) : null
  ]);
  return { ticket: t, messages: messages || [], order };
}

async function team(cfg) {
  const rows = await sb(cfg, '/rest/v1/admins?select=email,role,added_by,created_at&order=created_at.asc');
  const fromEnv = (cfg.adminEmails || []).filter((e) => !(rows || []).some((r) => r.email === e))
    .map((e) => ({ email: e, role: 'owner', added_by: 'ADMIN_EMAILS', fixed: true }));
  return fromEnv.concat(rows || []);
}

async function read(cfg, params) {
  const view = params.view || 'overview';
  if (view === 'overview') return overview(cfg, params.range);
  if (view === 'orders') return { orders: await orders(cfg, params) };
  if (view === 'customers') return { customers: await customers(cfg, params) };
  if (view === 'payments') return payments(cfg, params);
  if (view === 'tickets') return { tickets: await tickets(cfg, params) };
  if (view === 'ticket') return ticket(cfg, params.id);
  if (view === 'team') return { team: await team(cfg) };
  throw new ShopError('Unknown view.');
}

// ---------- actions ----------

function dbError(e, map) {
  const key = Object.keys(map).find((k) => (e.db || '').includes(k));
  if (key) throw new ShopError(map[key], 400);
  throw e;
}

async function userByEmail(cfg, email) {
  const e = String(email || '').trim().toLowerCase();
  const rows = e ? await rpc(cfg, 'admin_users', { p_search: e, p_limit: 5, p_offset: 0 }) : [];
  const u = (rows || []).find((x) => String(x.email).toLowerCase() === e);
  if (!u) throw new ShopError('No customer with that email.', 404);
  return u;
}

async function act(cfg, admin, body) {
  const a = body.action;
  if (a === 'refund') {
    const bal = await rpc(cfg, 'admin_refund_order', { p_order: parseInt(body.orderId, 10), p_note: String(body.note || 'Refunded by support').slice(0, 200) })
      .catch((e) => dbError(e, { ALREADY_REFUNDED: 'This order was already refunded.', ORDER_BUSY: 'This order is still being placed. Try again in a minute.', ORDER_NOT_FOUND: 'Order not found.' }));
    return { ok: true, balance: num(bal) };
  }
  if (a === 'markPlaced') {
    const smm = String(body.smmOrder || '').trim();
    if (!/^\w{1,40}$/.test(smm)) throw new ShopError('Enter the panel’s order number.');
    await rpc(cfg, 'admin_mark_placed', { p_order: parseInt(body.orderId, 10), p_smm_order: smm })
      .catch((e) => dbError(e, { ORDER_NOT_CHECKING: 'Only orders marked “Being checked” can be marked placed.' }));
    return { ok: true };
  }
  if (a === 'orderStatus') {
    const o = await orderById(cfg, body.orderId);
    if (!o || !o.smm_order) throw new ShopError('This order has no panel order number.');
    const s = await shop.smm({ action: 'status', order: o.smm_order }, cfg);
    if (s && s.error) throw new ShopError('Panel said: ' + s.error, 502);
    return { status: s && s.status, startCount: s && s.start_count, remains: s && s.remains, charge: s && s.charge, currency: s && s.currency };
  }
  if (a === 'adjust') {
    const amount = Math.round(Number(body.amount) * 100) / 100;
    if (!amount || Math.abs(amount) > 100000) throw new ShopError('Enter an amount, e.g. 50 to add or -50 to take away.');
    const note = String(body.note || '').trim().slice(0, 160);
    if (note.length < 3) throw new ShopError('Add a short reason; it’s saved in the ledger.');
    const bal = await rpc(cfg, 'admin_adjust', { p_user: body.userId, p_delta: amount, p_note: note + ' (by ' + admin.email + ')' })
      .catch((e) => dbError(e, { BALANCE_NEGATIVE: 'That would take the wallet below ₹0.', BAD_AMOUNT: 'Enter a valid amount.' }));
    return { ok: true, balance: num(bal) };
  }
  if (a === 'creditAlert') {
    const u = await userByEmail(cfg, body.email);
    const bal = await rpc(cfg, 'admin_credit_alert', { p_utr: String(body.utr || ''), p_user: u.id })
      .catch((e) => dbError(e, { ALERT_USED: 'That payment was already credited.', ALERT_NOT_FOUND: 'Payment not found.', AMOUNT_TOO_SMALL: 'Payments under ₹1 can’t be credited this way; use a wallet adjustment.' }));
    return { ok: true, balance: num(bal), email: u.email };
  }
  if (a === 'syncInbox') return wallet.syncInbox(cfg, { force: true });
  if (a === 'reply') {
    const msg = String(body.message || '').trim();
    if (!msg || msg.length > 4000) throw new ShopError('Write a reply (up to 4,000 characters).');
    await rpc(cfg, 'ticket_post', { p_ticket: parseInt(body.ticketId, 10), p_user: null, p_staff: admin.email, p_body: msg })
      .catch((e) => dbError(e, { TICKET_NOT_FOUND: 'Ticket not found.' }));
    return ticket(cfg, body.ticketId);
  }
  if (a === 'ticketStatus') {
    if (!['open', 'closed'].includes(body.status)) throw new ShopError('Unknown status.');
    await sb(cfg, '/rest/v1/tickets?id=eq.' + parseInt(body.ticketId, 10), { method: 'PATCH', prefer: 'return=minimal', body: { status: body.status, updated_at: new Date().toISOString() } });
    return ticket(cfg, body.ticketId);
  }
  if (a === 'addAdmin' || a === 'removeAdmin') {
    if (admin.role !== 'owner') throw new ShopError('Only owners can change who has access.', 403);
    const email = String(body.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new ShopError('Enter a valid email address.');
    if (a === 'addAdmin') {
      const role = body.role === 'owner' ? 'owner' : 'staff';
      await sb(cfg, '/rest/v1/admins?on_conflict=email', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { email, role, added_by: admin.email } });
    } else {
      if (email === admin.email.toLowerCase()) throw new ShopError('You can’t remove yourself.');
      if ((cfg.adminEmails || []).includes(email)) throw new ShopError('This owner is set in ADMIN_EMAILS on Vercel; remove them there.');
      await sb(cfg, '/rest/v1/admins?email=eq.' + q(email), { method: 'DELETE', prefer: 'return=minimal' });
    }
    return { team: await team(cfg) };
  }
  throw new ShopError('Unknown action.');
}

// ---------- customers' tickets ----------

async function myTickets(user, cfg) {
  return sb(cfg, '/rest/v1/tickets?select=id,subject,category,order_id,status,customer_seen,created_at,updated_at&order=updated_at.desc&limit=50&user_id=eq.' + q(user.id));
}

async function myTicket(user, id, cfg) {
  const n = parseInt(id, 10);
  const t = first(await sb(cfg, '/rest/v1/tickets?select=id,subject,category,order_id,status,customer_seen,created_at,updated_at&id=eq.' + n + '&user_id=eq.' + q(user.id)));
  if (!t) throw new ShopError('Ticket not found.', 404);
  const messages = await sb(cfg, '/rest/v1/ticket_messages?select=id,from_staff,body,created_at&order=id.asc&ticket_id=eq.' + n);
  if (!t.customer_seen) {
    await sb(cfg, '/rest/v1/tickets?id=eq.' + n + '&user_id=eq.' + q(user.id), { method: 'PATCH', prefer: 'return=minimal', body: { customer_seen: true } });
    t.customer_seen = true;
  }
  return { ticket: t, messages: messages || [] };
}

async function openTicket(user, input, cfg) {
  const subject = String(input.subject || '').trim();
  const message = String(input.message || '').trim();
  const category = TICKET_CATEGORIES.includes(input.category) ? input.category : 'other';
  if (subject.length < 3 || subject.length > 140) throw new ShopError('Give your ticket a short subject (3 to 140 characters).');
  if (message.length < 5 || message.length > 4000) throw new ShopError('Tell us what happened (at least a few words).');
  const orderId = input.orderId ? parseInt(String(input.orderId).replace(/\D/g, ''), 10) || null : null;
  const id = await rpc(cfg, 'create_ticket', { p_user: user.id, p_email: user.email, p_subject: subject, p_category: category, p_order: orderId, p_body: message })
    .catch((e) => dbError(e, { TOO_MANY_TICKETS: 'You have 5 open tickets. Please wait for a reply or close one first.', ORDER_NOT_FOUND: 'That order number isn’t one of your orders.' }));
  return myTicket(user, id, cfg);
}

async function replyTicket(user, id, message, cfg) {
  const msg = String(message || '').trim();
  if (!msg || msg.length > 4000) throw new ShopError('Write a message (up to 4,000 characters).');
  await rpc(cfg, 'ticket_post', { p_ticket: parseInt(id, 10), p_user: user.id, p_staff: null, p_body: msg })
    .catch((e) => dbError(e, { TICKET_NOT_FOUND: 'Ticket not found.' }));
  return myTicket(user, id, cfg);
}

async function closeTicket(user, id, cfg) {
  await sb(cfg, '/rest/v1/tickets?id=eq.' + parseInt(id, 10) + '&user_id=eq.' + q(user.id), { method: 'PATCH', prefer: 'return=minimal', body: { status: 'closed', updated_at: new Date().toISOString() } });
  return myTicket(user, id, cfg);
}

async function unreadTickets(user, cfg) {
  const rows = await sb(cfg, '/rest/v1/tickets?select=id&customer_seen=eq.false&user_id=eq.' + q(user.id));
  return (rows || []).length;
}

module.exports = {
  roleOf, requireAdmin, read, act, rangeStart,
  myTickets, myTicket, openTicket, replyTicket, closeTicket, unreadTickets, TICKET_CATEGORIES
};
