// GET /api/status -> setup check: which keys are set, whether the panel answers, where prices come from.
const shop = require('../lib/shop');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  send(res, 200, await shop.status());
});
