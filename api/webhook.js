/*
 * POST /api/webhook  (Razorpay dashboard -> Webhooks, event: payment.captured)
 * Safety net for customers who close the tab during a recharge: credits the wallet if the page didn't.
 * Crediting is idempotent (one credit per Razorpay order), so the page and the webhook can both run.
 */
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const { readRaw, send, handler } = require('../lib/http');

module.exports = handler(['POST'], async (req, res) => {
  const cfg = shop.config();
  const raw = await readRaw(req);
  if (!cfg.webhookSecret || !shop.verifyWebhookSignature(raw, req.headers['x-razorpay-signature'], cfg.webhookSecret)) {
    return send(res, 401, { error: 'Bad signature' });
  }
  const event = JSON.parse(raw);
  const pay = event.payload && event.payload.payment && event.payload.payment.entity;
  if (event.event !== 'payment.captured' || !pay || !pay.notes || pay.notes.purpose !== 'recharge') {
    return send(res, 200, { ignored: true });
  }
  const r = await wallet.creditPayment(pay.id, cfg);   // errors -> 5xx, so Razorpay retries
  send(res, 200, { ok: true, balance: r.balance });
});

module.exports.config = { api: { bodyParser: false } };
