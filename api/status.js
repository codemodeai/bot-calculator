// GET /api/status            -> setup check: which keys are set, whether the panel answers, where prices come from,
//                               and when the bank alert inbox was last read.
// GET /api/status?check=1    -> also reads the inbox now (pay yourself ₹1 first to see it matched).
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const { send, query, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const cfg = shop.config();
  const out = await shop.status(cfg);
  out.inbox = await wallet.inboxStatus(cfg, query(req).get('check') === '1').catch((e) => ({ error: e.message }));
  send(res, 200, out);
});
