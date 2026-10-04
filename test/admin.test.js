const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('../lib/admin');

const CFG = { supabaseUrl: 'https://db.test', supabaseAnon: 'anon', supabaseService: 'service-key', smmKey: 'panel-key', adminEmails: ['boss@x.com'],
  upiId: 'store@okhdfcbank', gmail: 'g@gmail.com', gmailPass: 'p', storeName: 'Test' };
const USERS = {
  'tok-boss': { id: 'u-boss', email: 'Boss@x.com', email_confirmed_at: '2026-01-01' },
  'tok-staff': { id: 'u-staff', email: 'helper@x.com', email_confirmed_at: '2026-01-01' },
  'tok-cust': { id: 'u-cust', email: 'cust@x.com', email_confirmed_at: '2026-01-01' },
  'tok-unverified': { id: 'u-x', email: 'helper@x.com', email_confirmed_at: null }
};

// Fake Supabase: auth, the admins table, tickets and the RPCs these tests touch.
function fake() {
  const db = { admins: [{ email: 'helper@x.com', role: 'staff' }], tickets: [], messages: [], calls: [] };
  const reply = (status, data) => ({ status, text: async () => (data === undefined ? '' : JSON.stringify(data)) });
  global.fetch = async (url, init) => {
    init = init || {};
    const u = new URL(url), p = u.pathname, method = init.method || 'GET', data = init.body ? JSON.parse(init.body) : null;
    const eq = (k) => (u.searchParams.get(k) || '').replace(/^eq\./, '');
    db.calls.push(method + ' ' + p);
    if (p === '/auth/v1/user') { const t = (init.headers.Authorization || '').replace('Bearer ', ''); return USERS[t] ? reply(200, USERS[t]) : reply(401, {}); }
    assert.equal(init.headers.apikey, 'service-key');
    if (p === '/rest/v1/admins' && method === 'GET') return reply(200, db.admins.filter((a) => !u.searchParams.get('email') || a.email === eq('email')));
    if (p === '/rest/v1/admins' && method === 'POST') { db.admins = db.admins.filter((a) => a.email !== data.email).concat([data]); return reply(201); }
    if (p === '/rest/v1/admins' && method === 'DELETE') { db.admins = db.admins.filter((a) => a.email !== eq('email')); return reply(204); }
    if (p === '/rest/v1/tickets' && method === 'GET') return reply(200, db.tickets.filter((t) => (!u.searchParams.get('id') || String(t.id) === eq('id')) && (!u.searchParams.get('user_id') || t.user_id === eq('user_id')) && (!u.searchParams.get('customer_seen') || String(t.customer_seen) === eq('customer_seen'))));
    if (p === '/rest/v1/tickets' && method === 'PATCH') { db.tickets.filter((t) => String(t.id) === eq('id') && (!u.searchParams.get('user_id') || t.user_id === eq('user_id'))).forEach((t) => Object.assign(t, data)); return reply(204); }
    if (p === '/rest/v1/ticket_messages') {
      const cols = (u.searchParams.get('select') || '*').split(',');        // like PostgREST: only the columns asked for
      return reply(200, db.messages.filter((m) => String(m.ticket_id) === eq('ticket_id'))
        .map((m) => (cols[0] === '*' ? m : Object.fromEntries(cols.map((c) => [c, m[c]]).filter(([, v]) => v !== undefined)))));
    }
    if (p === '/rest/v1/rpc/create_ticket') {
      if (data.p_order === 99) return reply(400, { message: 'ORDER_NOT_FOUND' });
      const t = { id: db.tickets.length + 1, user_id: data.p_user, email: data.p_email, subject: data.p_subject, category: data.p_category, status: 'open', customer_seen: true };
      db.tickets.push(t); db.messages.push({ ticket_id: t.id, from_staff: false, body: data.p_body });
      return reply(200, t.id);
    }
    if (p === '/rest/v1/rpc/ticket_post') {
      const t = db.tickets.find((x) => x.id === data.p_ticket && (!data.p_user || x.user_id === data.p_user));
      if (!t) return reply(400, { message: 'TICKET_NOT_FOUND' });
      db.messages.push({ ticket_id: t.id, from_staff: !data.p_user, author: data.p_staff, body: data.p_body });
      Object.assign(t, data.p_user ? { status: 'open', customer_seen: true } : { status: 'answered', customer_seen: false });
      return reply(200, t.status);
    }
    if (p === '/rest/v1/rpc/admin_adjust') return data.p_delta < -10 ? reply(400, { message: 'BALANCE_NEGATIVE' }) : reply(200, 10 + data.p_delta);
    return reply(404, { message: 'no route ' + method + ' ' + p });
  };
  return db;
}
const req = (t) => ({ headers: { authorization: 'Bearer ' + t } });

test('only owners, staff and ADMIN_EMAILS get in; customers and unverified emails don’t', async () => {
  fake();
  assert.equal((await admin.requireAdmin(req('tok-boss'), CFG)).role, 'owner', 'ADMIN_EMAILS, any letter case');
  assert.equal((await admin.requireAdmin(req('tok-staff'), CFG)).role, 'staff');
  await assert.rejects(admin.requireAdmin(req('tok-cust'), CFG), (e) => e.status === 403);
  await assert.rejects(admin.requireAdmin(req('tok-unverified'), CFG), (e) => e.status === 403, 'email must be verified');
  await assert.rejects(admin.requireAdmin(req('nope'), CFG), (e) => e.status === 401);
});

test('only owners can add or remove admins', async () => {
  const db = fake();
  const boss = await admin.requireAdmin(req('tok-boss'), CFG);
  const staff = await admin.requireAdmin(req('tok-staff'), CFG);
  await assert.rejects(admin.act(CFG, staff, { action: 'addAdmin', email: 'x@y.com' }), /Only owners/);
  const r = await admin.act(CFG, boss, { action: 'addAdmin', email: ' New.Helper@Y.com ' });
  assert.ok(r.team.some((a) => a.email === 'new.helper@y.com' && a.role === 'staff'));
  assert.ok(r.team.some((a) => a.email === 'boss@x.com' && a.fixed), 'ADMIN_EMAILS owners are listed');
  await assert.rejects(admin.act(CFG, boss, { action: 'removeAdmin', email: 'boss@x.com' }), /yourself/);
  await admin.act(CFG, boss, { action: 'removeAdmin', email: 'helper@x.com' });
  assert.ok(!db.admins.some((a) => a.email === 'helper@x.com'));
  await assert.rejects(admin.requireAdmin(req('tok-staff'), CFG), (e) => e.status === 403, 'removed staff lose access at once');
});

test('wallet adjustments need an amount and a reason', async () => {
  fake();
  const boss = await admin.requireAdmin(req('tok-boss'), CFG);
  await assert.rejects(admin.act(CFG, boss, { action: 'adjust', userId: 'u-cust', amount: 0, note: 'x' }), /Enter an amount/);
  await assert.rejects(admin.act(CFG, boss, { action: 'adjust', userId: 'u-cust', amount: 5, note: '' }), /reason/);
  assert.equal((await admin.act(CFG, boss, { action: 'adjust', userId: 'u-cust', amount: 5, note: 'Goodwill' })).balance, 15);
  await assert.rejects(admin.act(CFG, boss, { action: 'adjust', userId: 'u-cust', amount: -50, note: 'Fix' }), /below ₹0/);
});

test('tickets: customers open, reply and close their own; staff replies show as unread', async () => {
  const db = fake();
  const cust = { id: 'u-cust', email: 'cust@x.com' }, other = { id: 'u-other', email: 'o@x.com' };
  await assert.rejects(admin.openTicket(cust, { subject: 'Hi', message: 'help please' }, CFG), /subject/);
  await assert.rejects(admin.openTicket(cust, { subject: 'Order stuck', message: '' }, CFG), /what happened/);
  await assert.rejects(admin.openTicket(cust, { subject: 'Order stuck', message: 'Not delivered yet', orderId: '#99' }, CFG), /isn’t one of your orders/);
  const t = await admin.openTicket(cust, { subject: 'Order stuck', category: 'order', message: 'Not delivered yet' }, CFG);
  assert.equal(t.ticket.status, 'open');
  await assert.rejects(admin.myTicket(other, t.ticket.id, CFG), /not found/, 'other customers can’t read it');
  await assert.rejects(admin.replyTicket(other, t.ticket.id, 'hi', CFG), /not found/);

  const boss = await admin.requireAdmin(req('tok-boss'), CFG);
  await admin.act(CFG, boss, { action: 'reply', ticketId: t.ticket.id, message: 'On it!' });
  assert.equal(await admin.unreadTickets(cust, CFG), 1);
  const seen = await admin.myTicket(cust, t.ticket.id, CFG);
  assert.equal(seen.ticket.status, 'answered');
  assert.ok(seen.messages.every((m) => m.author === undefined), 'customers never see staff emails');
  assert.equal(await admin.unreadTickets(cust, CFG), 0, 'opening it marks it read');
  assert.equal((await admin.replyTicket(cust, t.ticket.id, 'Thanks', CFG)).ticket.status, 'open');
  assert.equal((await admin.closeTicket(cust, t.ticket.id, CFG)).ticket.status, 'closed');
  assert.equal(db.messages.length, 3);
});

test('date ranges start at midnight India time', () => {
  const today = new Date(admin.rangeStart('today'));
  assert.equal((today.getUTCHours() * 60 + today.getUTCMinutes()), 18 * 60 + 30, '00:00 IST = 18:30 UTC');
  assert.equal(admin.rangeStart('all'), new Date(0).toISOString());
  assert.equal((Date.parse(admin.rangeStart('today')) - Date.parse(admin.rangeStart('7d'))) / 86400e3, 6);
});
