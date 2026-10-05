// GET /api/wallet -> the signed-in customer's balance, recent orders (gradual ones with their parts) and recharges,
//                    unread support replies, and whether they may open the admin panel.
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const admin = require('../lib/admin');
const drip = require('../lib/drip');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const cfg = shop.config();
  const user = await wallet.currentUser(req, cfg);
  await drip.runDueForUser(user, cfg).catch(() => null);         // backup for the scheduler
  const [w, role, unread] = await Promise.all([
    wallet.wallet(user, cfg),
    admin.roleOf(user, cfg).catch(() => null),
    admin.unreadTickets(user, cfg).catch(() => 0)
  ]);
  await drip.attachParts(cfg, w.orders).catch(() => null);
  send(res, 200, Object.assign(w, { isAdmin: !!role, unreadTickets: unread }));
});
