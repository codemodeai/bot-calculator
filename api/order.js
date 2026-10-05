// POST /api/order { serviceId, quantity, link }           -> pays the exact price from the wallet and places the panel order
// POST /api/order { serviceId, quantity, link, drip: { parts | split, intervalMinutes } }
//                                                        -> gradual delivery: +20%, sent to the panel in parts over time
// POST /api/order { cancel: orderId }                    -> cancel the unsent parts of a gradual order (refunded)
const wallet = require('../lib/wallet');
const drip = require('../lib/drip');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  const body = await readJson(req);
  if (body.cancel) return send(res, 200, await drip.cancel(user, body.cancel));
  send(res, 200, body.drip ? await drip.placeDripOrder(user, body) : await wallet.placeOrder(user, body));
});
