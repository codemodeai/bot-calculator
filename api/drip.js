// GET|POST /api/drip -> sends the gradual-delivery parts that are due. Supabase's scheduler (pg_cron) calls it
// every 5 minutes. It only ever sends parts whose time has come, so calling it more often is harmless.
// If CRON_SECRET is set in Vercel, callers must send "Authorization: Bearer <CRON_SECRET>".
const shop = require('../lib/shop');
const drip = require('../lib/drip');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET', 'POST'], async (req, res) => {
  const cfg = shop.config();
  const secret = process.env.CRON_SECRET || '';
  if (secret && String(req.headers.authorization || '') !== 'Bearer ' + secret) return send(res, 401, { error: 'Unauthorized' });
  if (shop.mode(cfg) !== 'live') return send(res, 200, { skipped: 'demo mode' });
  const r = await drip.processDue(cfg, { limit: 20 });
  send(res, 200, { ok: true, sent: r.results.filter((x) => x === 'placed').length, checked: r.claimed, results: r.results });
});
