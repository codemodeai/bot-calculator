// POST /api/create-order { serviceId, quantity, link, email } -> Razorpay order (price computed here, not in the browser).
const shop = require('../lib/shop');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  send(res, 200, await shop.createOrder(await readJson(req)));
});
