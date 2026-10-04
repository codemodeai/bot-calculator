// GET /api/order-status?id=123 -> delivery status of one of the signed-in customer's orders.
const wallet = require('../lib/wallet');
const { send, query, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const user = await wallet.currentUser(req);
  send(res, 200, await wallet.orderStatus(user, query(req).get('id')));
});
