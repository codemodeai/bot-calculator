// POST /api/order { serviceId, quantity, link } -> pays the exact price from the wallet and places the panel order.
const wallet = require('../lib/wallet');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  send(res, 200, await wallet.placeOrder(user, await readJson(req)));
});
