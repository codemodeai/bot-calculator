// POST /api/recharge { amount }   -> a UPI payment for the wallet: exact amount, UPI link and QR (min ₹1)
// GET  /api/recharge?id=123       -> pending / paid / expired (checks the bank alert inbox while it waits)
// POST /api/recharge { id, utr }  -> "I've paid": match the payment by the UTR from the customer's UPI app
const wallet = require('../lib/wallet');
const { readJson, send, query, handler } = require('../lib/http');

module.exports = handler(['GET', 'POST'], async (req, res) => {
  const user = await wallet.currentUser(req);
  if (req.method === 'GET') return send(res, 200, await wallet.rechargeStatus(user, query(req).get('id')));
  const body = await readJson(req);
  send(res, 200, body.utr != null ? await wallet.claimUtr(user, body.id, body.utr) : await wallet.createRecharge(user, body));
});
