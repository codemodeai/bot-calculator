// POST /api/verify-payment { razorpay_order_id, razorpay_payment_id, razorpay_signature }
// Checks the signature, then places the order on the SMM panel.
const shop = require('../lib/shop');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  send(res, 200, await shop.verifyAndFulfil(await readJson(req)));
});
