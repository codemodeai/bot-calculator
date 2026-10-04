// GET /api/order-status?id=pay_XXXX -> delivery status from the SMM panel.
const shop = require('../lib/shop');
const { send, query, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  send(res, 200, await shop.orderStatus(query(req).get('id')));
});
