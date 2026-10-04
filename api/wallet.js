// GET /api/wallet -> the signed-in customer's balance, recent orders and recharges, unread support replies,
//                    and whether they may open the admin panel.
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const admin = require('../lib/admin');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const cfg = shop.config();
  const user = await wallet.currentUser(req, cfg);
  const [w, role, unread] = await Promise.all([
    wallet.wallet(user, cfg),
    admin.roleOf(user, cfg).catch(() => null),
    admin.unreadTickets(user, cfg).catch(() => 0)
  ]);
  send(res, 200, Object.assign(w, { isAdmin: !!role, unreadTickets: unread }));
});
