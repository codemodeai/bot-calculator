// POST /api/recharge { amount }               -> Razorpay order to add money to the wallet (min ₹1)
// POST /api/recharge { razorpay_order_id, razorpay_payment_id, razorpay_signature } -> verify and credit
const wallet = require('../lib/wallet');
const { readJson, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  const body = await readJson(req);
  send(res, 200, body.razorpay_payment_id ? await wallet.verifyRecharge(user, body) : await wallet.createRecharge(user, body));
});
