// POST /api/order { serviceId, quantity, link }           -> pays the exact price from the wallet and places the panel order
// POST /api/order { serviceId, quantity, link, drip: { parts | split, intervalMinutes } }
//                                                        -> gradual delivery: +20%, sent to the panel in parts over time
// POST /api/order { cancel: orderId }                    -> cancel: a gradual order's unsent parts (refunded now), or ask
//                                                           the panel to cancel (refunded when the panel confirms)
// POST /api/order { refill: orderId }                    -> ask the panel to refill a completed order
const wallet = require('../lib/wallet');
const drip = require('../lib/drip');
const orders = require('../lib/orders');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  const body = await readJson(req);
  if (body.cancel) return send(res, 200, await orders.cancel(user, body.cancel));
  if (body.refill) return send(res, 200, await orders.refill(user, body.refill));
  send(res, 200, body.drip ? await drip.placeDripOrder(user, body) : await wallet.placeOrder(user, body));
});
