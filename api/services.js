// GET /api/services -> store settings + catalogue with selling prices (markup applied).
const shop = require('../lib/shop');
const { send, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const cfg = shop.config();
  const cat = await shop.catalogue(cfg);
  send(res, 200, {
    mode: shop.mode(cfg),
    storeName: cfg.storeName,
    support: cfg.support,
    currency: 'INR',
    priceSource: cat.source,
    services: cat.services
  }, { 'Cache-Control': 'public, max-age=60' });
});
