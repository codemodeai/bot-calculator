// GET  /api/tickets                  -> the signed-in customer's support tickets
// GET  /api/tickets?id=12            -> one ticket with its messages (marks the team's replies as read)
// POST /api/tickets { subject, category, orderId?, message }  -> open a ticket
// POST /api/tickets { id, message }  -> reply      POST /api/tickets { id, close: true } -> close
const wallet = require('../lib/wallet');
const admin = require('../lib/admin');
const { readJson, send, query, handler } = require('../lib/http');

module.exports = handler(['GET', 'POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  if (req.method === 'GET') {
    const id = query(req).get('id');
    return send(res, 200, id ? await admin.myTicket(user, id) : { tickets: await admin.myTickets(user) });
  }
  const b = await readJson(req);
  if (b.id && b.close) return send(res, 200, await admin.closeTicket(user, b.id));
  if (b.id) return send(res, 200, await admin.replyTicket(user, b.id, b.message));
  send(res, 200, await admin.openTicket(user, b));
});
