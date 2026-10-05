// GET /api/order-status?id=123 -> delivery status of one of the signed-in customer's orders
//                                 (for gradual orders: every part, what's delivered and when the next part goes).
const wallet = require('../lib/wallet');
const drip = require('../lib/drip');
const { send, query, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const user = await wallet.currentUser(req);
  send(res, 200, await drip.orderStatus(user, query(req).get('id')));
});
