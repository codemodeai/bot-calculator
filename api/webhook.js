/*
 * POST /api/webhook  (Razorpay dashboard -> Webhooks, event: payment.captured)
 * Safety net for customers who close the tab before /api/verify-payment runs.
 * The browser normally fulfils within seconds, so for the first 2 minutes after a payment we answer 503
 * and let Razorpay retry later; that keeps the two paths from placing the same order twice.
 */
const shop = require('../lib/shop');
const { readRaw, send, handler } = require('../lib/http');

const GRACE_SECONDS = 120;

module.exports = handler(['POST'], async (req, res) => {
  const cfg = shop.config();
  const raw = await readRaw(req);
  if (!cfg.webhookSecret || !shop.verifyWebhookSignature(raw, req.headers['x-razorpay-signature'], cfg.webhookSecret)) {
    return send(res, 401, { error: 'Bad signature' });
  }
  const event = JSON.parse(raw);
  const pay = event.payload && event.payload.payment && event.payload.payment.entity;
  if (event.event !== 'payment.captured' || !pay) return send(res, 200, { ignored: event.event });
  if (pay.notes && pay.notes.smm_order) return send(res, 200, { ok: true, already: true });
  if (Date.now() / 1000 - pay.created_at < GRACE_SECONDS) return send(res, 503, { retry: true });
  try {
    send(res, 200, Object.assign({ ok: true }, await shop.fulfil(pay.id, cfg)));
  } catch (e) {
    // The failure is recorded on the payment; answer 200 so Razorpay doesn't retry a refused order forever.
    send(res, 200, { ok: false, error: e.message });
  }
});

module.exports.config = { api: { bodyParser: false } };
