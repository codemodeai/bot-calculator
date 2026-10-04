// GET /api/services -> store settings + catalogue with selling prices (markup applied).
// GET /api/services?only=config -> just the store mode, name and public sign-in settings.
const shop = require('../lib/shop');
const wallet = require('../lib/wallet');
const { send, query, handler } = require('../lib/http');

module.exports = handler(['GET'], async (req, res) => {
  const cfg = shop.config();
  if (query(req).get('only') === 'config') {      // the admin page only needs sign-in settings
    return send(res, 200, { mode: shop.mode(cfg), storeName: cfg.storeName, supabaseUrl: cfg.supabaseUrl, supabaseAnonKey: cfg.supabaseAnon });
  }
  const cat = await shop.catalogue(cfg);
  send(res, 200, {
    mode: shop.mode(cfg),
    storeName: cfg.storeName,
    support: cfg.support,
    supabaseUrl: cfg.supabaseUrl,
    supabaseAnonKey: cfg.supabaseAnon,
    minRecharge: wallet.MIN_RECHARGE,
    currency: 'INR',
    priceSource: cat.source,
    pricesFetchedAt: cat.fetchedAt,
    pricesStale: cat.stale,
    services: cat.services
  }, { 'Cache-Control': 'public, max-age=60' });
});
