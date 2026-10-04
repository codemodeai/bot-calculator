// GET  /api/admin?view=overview|orders|customers|payments|tickets|ticket|team  -> admin panel data
// POST /api/admin { action, ... }   -> refund, markPlaced, orderStatus, adjust, creditAlert, syncInbox, reply,
//                                      ticketStatus, addAdmin, removeAdmin
// Only for admins (see lib/admin.js); everyone else gets 403.
const shop = require('../lib/shop');
const admin = require('../lib/admin');
const { readJson, send, query, handler } = require('../lib/http');

module.exports = handler(['GET', 'POST'], async (req, res) => {
  const cfg = shop.config();
  const who = await admin.requireAdmin(req, cfg);
  if (req.method === 'GET') {
    const out = await admin.read(cfg, Object.fromEntries(query(req)));
    return send(res, 200, Object.assign({ me: { email: who.email, role: who.role }, storeName: cfg.storeName }, out));
  }
  send(res, 200, await admin.act(cfg, who, await readJson(req)));
});
