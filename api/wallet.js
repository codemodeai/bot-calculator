// GET /api/wallet -> the signed-in customer's balance, recent orders and recharges.
const wallet = require('../lib/wallet');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const user = await wallet.currentUser(req);
  send(res, 200, await wallet.wallet(user));
});
