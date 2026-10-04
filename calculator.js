/*
 * SMM services price calculator — core logic.
 * Works in the browser (window.SmmCalc) and in Node (require('./calculator')).
 *
 * Service shape (normalised):
 *   { id, name, category, rate, min, max, currency, time, description, refill, cancel, dripfeed }
 * `rate` is the price per 1000 units, as on SMM panel /services pages.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SmmCalc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CURRENCY_SYMBOLS = {
    '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '₽': 'RUB', '₺': 'TRY',
    '₦': 'NGN', '৳': 'BDT', '₨': 'PKR', 'R$': 'BRL', '₱': 'PHP', '₫': 'VND', 'Rp': 'IDR'
  };

  function round(n, dp) {
    var f = Math.pow(10, dp == null ? 2 : dp);
    return Math.round((n + Number.EPSILON) * f) / f;
  }

  // "$0.4500", "₹ 1,234.50", "0,45 €", "1.234,50" -> { value, currency }
  function parseMoney(text) {
    if (typeof text === 'number') return { value: text, currency: null };
    var s = String(text == null ? '' : text).trim();
    var currency = null;
    var syms = Object.keys(CURRENCY_SYMBOLS).sort(function (a, b) { return b.length - a.length; });
    for (var i = 0; i < syms.length; i++) {
      if (s.indexOf(syms[i]) !== -1) { currency = CURRENCY_SYMBOLS[syms[i]]; break; }
    }
    if (!currency) {
      var code = s.match(/\b(USD|EUR|GBP|INR|RUB|TRY|NGN|BDT|PKR|BRL|PHP|VND|IDR|USDT)\b/i);
      if (code) currency = code[1].toUpperCase();
    }
    var num = s.replace(/[^0-9.,-]/g, '');
    if (num.indexOf(',') !== -1 && num.indexOf('.') !== -1) {
      // whichever separator comes last is the decimal separator
      if (num.lastIndexOf(',') > num.lastIndexOf('.')) num = num.replace(/\./g, '').replace(',', '.');
      else num = num.replace(/,/g, '');
    } else if (num.indexOf(',') !== -1) {
      // "0,45" is decimal; "1,000" is thousands
      num = /,\d{3}$/.test(num) && !/^0,/.test(num) ? num.replace(/,/g, '') : num.replace(',', '.');
    }
    var value = parseFloat(num);
    return { value: isNaN(value) ? NaN : value, currency: currency };
  }

  function parseIntLoose(v) {
    if (typeof v === 'number') return Math.floor(v);
    var n = parseInt(String(v == null ? '' : v).replace(/[^0-9]/g, ''), 10);
    return isNaN(n) ? NaN : n;
  }

  function truthy(v) {
    return v === true || v === 1 || v === '1' || /^(true|yes|on)$/i.test(String(v));
  }

  function normaliseService(raw, fallbackCurrency) {
    var money = parseMoney(raw.rate != null ? raw.rate : raw.price);
    return {
      id: String(raw.service != null ? raw.service : raw.id).trim(),
      name: String(raw.name || '').trim(),
      category: String(raw.category || 'Uncategorised').trim(),
      rate: money.value,
      min: parseIntLoose(raw.min),
      max: parseIntLoose(raw.max),
      currency: raw.currency || money.currency || fallbackCurrency || 'USD',
      time: raw.time || raw.average_time || '',
      description: raw.description || raw.desc || '',
      type: raw.type || 'Default',
      refill: truthy(raw.refill),
      cancel: truthy(raw.cancel),
      dripfeed: truthy(raw.dripfeed)
    };
  }

  function isValidService(s) {
    return s.id && s.name && isFinite(s.rate) && s.rate >= 0;
  }

  /*
   * Parse JSON as returned by a Perfect Panel API (`action=services`), i.e.
   *   [{ service, name, type, category, rate, min, max, refill, cancel, dripfeed }]
   * or { currency, services: [...] }.
   */
  function parseJson(text) {
    var data = typeof text === 'string' ? JSON.parse(text) : text;
    var list = Array.isArray(data) ? data : (data.services || data.data || []);
    var currency = Array.isArray(data) ? null : data.currency;
    return list.map(function (r) { return normaliseService(r, currency); }).filter(isValidService);
  }

  /*
   * Parse the services table copied from a panel's /services page (select all, copy, paste).
   * Rows are tab-separated: ID, Service, Rate per 1000, Min order, Max order, [Average time], [Description].
   * A line that does not start with a numeric ID is treated as a category heading.
   */
  function parseTable(text) {
    var lines = String(text).replace(/\r/g, '').split('\n');
    var category = 'Uncategorised';
    var out = [];
    var pending = null; // description lines that follow a row
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line.trim()) continue;
      // Service names often contain "|", so only split on it for markdown-style rows ("| 1 | ... |").
      var sep = line.indexOf('\t') !== -1 ? /\t/ : /^\s*\|/.test(line) ? /\|/ : /\s{2,}/;
      var cells = line.split(sep).map(function (c) { return c.trim(); }).filter(Boolean);
      if (/^[-:\s|]+$/.test(line)) continue; // markdown separator row
      if (/^(id|#)$/i.test(cells[0]) && cells.some(function (c) { return /rate|price/i.test(c); })) continue; // header
      if (/^\d+$/.test(cells[0]) && cells.length >= 5) {
        var s = normaliseService({
          id: cells[0], name: cells[1], rate: cells[2], min: cells[3], max: cells[4],
          time: cells[5] || '', description: cells.slice(6).join(' '), category: category
        });
        if (isValidService(s)) { out.push(s); pending = s; }
        continue;
      }
      if (cells.length === 1 && pending && /^(details|description|start|speed|quality|refill|guarantee|-|•)/i.test(cells[0])) {
        pending.description = (pending.description ? pending.description + '\n' : '') + cells[0];
        continue;
      }
      category = cells.join(' ');
      pending = null;
    }
    return out;
  }

  // Parse CSV with a header row (id,name,category,rate,min,max,...)
  function parseCsv(text) {
    var rows = [];
    var row = [], field = '', q = false, s = String(text).replace(/\r/g, '');
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) {
        if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
        else if (ch === '"') q = false;
        else field += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(field); field = ''; }
      else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    if (!rows.length) return [];
    var head = rows.shift().map(function (h) { return h.trim().toLowerCase().replace(/[^a-z]/g, ''); });
    var alias = { service: 'id', serviceid: 'id', ratepercomma: 'rate', rateper: 'rate', price: 'rate', minorder: 'min', maxorder: 'max', averagetime: 'time' };
    return rows.filter(function (r) { return r.join('').trim(); }).map(function (r) {
      var o = {};
      head.forEach(function (h, j) {
        var key = alias[h] || (/^rate/.test(h) ? 'rate' : h);
        o[key] = r[j];
      });
      return normaliseService(o);
    }).filter(isValidService);
  }

  // Auto-detect the pasted format.
  function parseAny(text) {
    var t = String(text).trim();
    if (!t) return [];
    if (t[0] === '[' || t[0] === '{') return parseJson(t);
    var first = t.split('\n')[0].toLowerCase();
    if (first.indexOf(',') !== -1 && /\b(id|service)\b/.test(first) && /\b(rate|price)\b/.test(first) && first.indexOf('\t') === -1) {
      return parseCsv(t);
    }
    return parseTable(t);
  }

  function groupByCategory(services) {
    var map = {}, order = [];
    services.forEach(function (s) {
      if (!map[s.category]) { map[s.category] = []; order.push(s.category); }
      map[s.category].push(s);
    });
    return order.map(function (c) { return { category: c, services: map[c] }; });
  }

  // Best-effort platform detection from category / service name.
  var PLATFORMS = ['Instagram', 'TikTok', 'YouTube', 'Facebook', 'Twitter', 'Telegram', 'Spotify', 'Twitch',
    'LinkedIn', 'Threads', 'Snapchat', 'Pinterest', 'SoundCloud', 'Discord', 'Reddit', 'Kick', 'Quora',
    'Tumblr', 'VK', 'Shopee', 'Website', 'Google', 'Apple Music', 'Audiomack', 'WhatsApp'];
  function platformOf(s) {
    var hay = (s.category + ' ' + s.name).toLowerCase();
    if (/\bx\b|twitter/.test(hay)) return 'Twitter';
    var SHORT = { ig: 'Instagram', insta: 'Instagram', yt: 'YouTube', tg: 'Telegram', fb: 'Facebook', tt: 'TikTok' };
    var m = hay.match(/\b(ig|insta|yt|tg|fb|tt)\b/);
    if (m && hay.indexOf('tiktok') === -1) return SHORT[m[1]];
    for (var i = 0; i < PLATFORMS.length; i++) if (hay.indexOf(PLATFORMS[i].toLowerCase()) !== -1) return PLATFORMS[i];
    if (/traffic|visit/.test(hay)) return 'Website';
    return 'Other';
  }

  /*
   * Price a single order.
   *   opts.quantity  units per run
   *   opts.runs      drip-feed runs (default 1)
   *   opts.markup    reseller markup in percent (default 0)
   *   opts.discount  discount in percent (default 0)
   */
  function quote(service, opts) {
    opts = opts || {};
    var qty = parseIntLoose(opts.quantity);
    var runs = Math.max(1, parseIntLoose(opts.runs) || 1);
    var markup = Number(opts.markup) || 0;
    var discount = Number(opts.discount) || 0;
    var errors = [];
    if (!(qty > 0)) errors.push('Enter a quantity.');
    else {
      if (isFinite(service.min) && qty < service.min) errors.push('Minimum order is ' + service.min + '.');
      if (isFinite(service.max) && service.max > 0 && qty > service.max) errors.push('Maximum order is ' + service.max + '.');
    }
    var totalQty = (qty || 0) * runs;
    var cost = service.rate * totalQty / 1000;
    var sell = cost * (1 + markup / 100) * (1 - discount / 100);
    return {
      service: service,
      quantity: qty || 0,
      runs: runs,
      totalQuantity: totalQty,
      cost: round(cost, 4),
      price: round(sell, 4),
      profit: round(sell - cost, 4),
      pricePerUnit: totalQty ? sell / totalQty : 0,
      valid: errors.length === 0,
      errors: errors
    };
  }

  // How many units a budget buys (respecting min/max, rounded down).
  function quantityForBudget(service, budget, opts) {
    opts = opts || {};
    var markup = Number(opts.markup) || 0;
    var discount = Number(opts.discount) || 0;
    var perThousand = service.rate * (1 + markup / 100) * (1 - discount / 100);
    if (!(perThousand > 0)) return { quantity: Infinity, affordable: true };
    var qty = Math.floor(Number(budget) * 1000 / perThousand + 1e-9);
    if (isFinite(service.max) && service.max > 0 && qty > service.max) qty = service.max;
    return { quantity: qty, affordable: !(isFinite(service.min) && qty < service.min) };
  }

  // Selling rate per 1000 after the store's markup (percent).
  function retailRate(rate, markup) {
    return round(rate * (1 + (Number(markup) || 0) / 100), 4);
  }

  // Round a selling rate per 1000 up to a tidy number: ₹0.288 -> ₹0.30, ₹20.91 -> ₹21, ₹152 -> ₹155.
  function niceRate(rate) {
    var step = rate < 1 ? 0.05 : rate < 10 ? 0.1 : rate < 100 ? 1 : 5;
    return round(Math.ceil(round(rate / step, 6)) * step, 2);
  }

  // Exact price for `qty` units at `rate` per 1000, used for wallet orders: rounded up to 1/100 paisa (4 dp), no minimum.
  function exactCharge(rate, qty) {
    var exact = round(rate * qty / 1000, 8);
    return Math.ceil(exact * 10000 - 1e-6) / 10000;
  }

  // "₹12.50", "₹0.24", "₹0.024", "₹11.616": two decimals, up to four when the amount has them.
  function formatPrice(value, currency) {
    if (!isFinite(value)) return '—';
    var dp = 4;
    while (dp > 2 && round(value, dp - 1) === round(value, dp)) dp--;
    return formatMoney(round(value, dp), currency, dp);
  }

  function formatMoney(value, currency, dp) {
    if (!isFinite(value)) return '—';
    dp = dp == null ? (Math.abs(value) < 1 && value !== 0 ? 4 : 2) : dp;
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency || 'USD', minimumFractionDigits: dp, maximumFractionDigits: dp }).format(value);
    } catch (e) {
      return (currency ? currency + ' ' : '') + value.toFixed(dp);
    }
  }

  function toCsv(services) {
    var cols = ['id', 'category', 'name', 'rate', 'min', 'max', 'currency', 'time', 'refill', 'cancel', 'dripfeed', 'description'];
    var esc = function (v) {
      v = v == null ? '' : String(v);
      return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return [cols.join(',')].concat(services.map(function (s) {
      return cols.map(function (c) { return esc(s[c]); }).join(',');
    })).join('\n');
  }

  // ---------- simple mode: platform -> service type -> Cheap / Smart / Very fast ----------

  // Panel names use Unicode bold/superscript letters ("𝐔𝐋𝐓𝐑𝐀 𝐅𝐀𝐒𝐓", "ᴺᴱᵂ"); NFKC turns them into plain text.
  function plain(text) {
    var t = String(text || '');
    return (t.normalize ? t.normalize('NFKC') : t).toLowerCase();
  }

  var TYPES = [
    ['Comment Likes', /comment likes?/],
    ['Subscribers', /subscri/],
    ['Followers', /follower/],
    ['Members', /member/],
    ['Comments', /comment/],
    ['Likes', /\blikes?\b/],
    ['Views', /\bviews?\b|watch ?time/]
  ];
  function serviceType(s) {
    var name = plain(s.name), cat = plain(s.category);
    for (var i = 0; i < TYPES.length; i++) if (TYPES[i][1].test(name)) return TYPES[i][0];
    for (var j = 0; j < TYPES.length; j++) if (TYPES[j][1].test(cat)) return TYPES[j][0];
    return 'Other';
  }

  function unitValue(num, suffix) {
    return parseFloat(num) * (suffix === 'm' ? 1e6 : suffix === 'k' ? 1e3 : 1);
  }

  // Delivery speed in units per hour, read from text like "Speed: 300K/Day", "1M / hour", "Day 1M", "20M Day".
  function speedPerHour(s) {
    var t = plain(s.name + ' | ' + s.category)
      .replace(/(start(\s*time)?\s*:?\s*)?\d+\s*-\s*\d+\s*(hours?|hrs?|mins?|minutes?|seconds?)/g, ' ');
    var m = t.match(/speed\s*:?\s*(?:upto\s*)?(\d+(?:\.\d+)?)\s*([km])?\+?\s*(?:\/|per)?\s*(day|hours?|hrs?)\b/) ||
            t.match(/(\d+(?:\.\d+)?)\s*([km])\+?\s*(?:\/|per)?\s*(day|hours?|hrs?)\b/);
    if (m) return unitValue(m[1], m[2]) / (m[3] === 'day' ? 24 : 1);
    m = t.match(/\bday\s+(\d+(?:\.\d+)?)\s*([km])\b/);
    if (m) return unitValue(m[1], m[2]) / 24;
    return null;
  }

  // Hours until the order starts.
  function startHours(s) {
    var t = plain(s.name);
    var m = t.match(/(\d+)\s*-\s*(\d+)\s*(hours?|hrs?|mins?|minutes?)/);
    if (m) return /^m/.test(m[3]) ? parseInt(m[2], 10) / 60 : parseInt(m[2], 10);
    return /instant/.test(t) ? 0 : 1;
  }

  function isFastByName(s) { return /super ?fast|ultra ?fast|fastest|ultra fast|high speed|⚡/.test(plain(s.name + ' ' + s.category)); }

  function refillInfo(s) {
    var t = plain(s.name);
    if (/no refill/.test(t)) return { days: 0, label: 'No refill' };
    if (/lifetime/.test(t)) return { days: 9999, label: 'Lifetime refill' };
    var m = t.match(/(\d+)\s*days?\s*(♻|refill)/);
    if (m) return { days: +m[1], label: m[1] + '-day refill' };
    return s.refill ? { days: 30, label: 'Refill' } : { days: 0, label: 'No refill' };
  }

  function qualityScore(s) {
    var t = plain(s.name + ' | ' + s.category), q = 0, r = refillInfo(s).days;
    q += r >= 9999 ? 3 : r >= 365 ? 2 : r > 0 ? 1 : 0;
    if (/non drop|no drop|drop:? 0%/.test(t)) q += 1;
    if (/\bhq\b|real|old accounts|premium quality/.test(t)) q += 1;
    if (/\blq\b|low quality/.test(t)) q -= 1;
    if (/smart choice|most trusted|recommended|best working/.test(t)) q += 2;
    return q;
  }

  // Short plain-language tags for a service, e.g. ["Real accounts", "No drop", "Lifetime refill"].
  function features(s) {
    var t = plain(s.name), out = [];
    var m = t.match(/(\d+)\s*days?\s*premium/);
    if (m) out.push(m[1] + '-day premium');
    if (/\+\s*views/.test(t) && /member/.test(t)) out.push('With post views');
    if (/live ?stream/.test(t) && /comment/.test(t)) out.push('For live streams');
    if (/comment/.test(t) && !/comment likes?/.test(t)) {
      if (/\bcustom\b/.test(t)) out.push('Your own text');
      else if (/\bemoji\b/.test(t)) out.push('Emoji');
      else if (/\brandom\b/.test(t)) out.push('Random text');
    }
    var country = /india|🇮🇳/.test(t) ? 'Indian' : /\busa\b|🇺🇸|🇺🇲/.test(t) ? 'USA' : /\buk\b|🇬🇧/.test(t) ? 'UK' :
      /russia/.test(t) ? 'Russian' : /arab/.test(t) ? 'Arabic' : null;
    if (country) out.push(country + ' accounts');
    else if (/\blq\b|low quality/.test(t)) out.push('Basic accounts');
    else if (/\bmq\b/.test(t)) out.push('Standard accounts');
    else if (/\bhq\b|high quality|real|old accounts/.test(t)) out.push('Real accounts');
    if (/google search/.test(t)) out.push('From Google search');
    if (/adwords/.test(t)) out.push('Ad views');
    if (/watch ?time/.test(t) && !/seconds watch/.test(t)) out.push('Adds watch time');
    if (/reach|impression/.test(t)) out.push('Adds reach');
    if (/non drop|no drop|drop:? 0%/.test(t)) out.push('No drop');
    out.push(refillInfo(s).label);
    return out;
  }

  function estimateHours(s, qty) {
    var sp = speedPerHour(s);
    if (!sp) return null;
    return startHours(s) + (qty || 0) / sp;
  }

  function fitsQuantity(s, qty) {
    return !(qty > 0) || (!(qty < s.min) && !(s.max > 0 && qty > s.max));
  }

  /*
   * Pick up to four options for a group of services:
   *   cheap  - lowest rate (ties go to the faster / better one)
   *   smart  - best value among services with better refill or quality than the cheapest
   *   fast   - clearly faster than the cheapest
   *   best   - highest refill / quality score, when it beats all of the above
   * An option only appears when it differs from the others in a way that matters.
   * Services that can't take the quantity are only used when none can.
   */
  function pickOptions(services, qty) {
    if (!services.length) return [];
    var pool = services.filter(function (s) { return fitsQuantity(s, qty); });
    var outOfRange = !pool.length;
    if (outOfRange) pool = services.slice();
    var q = qty > 0 ? qty : 1000;
    var speedRank = function (s) {
      var est = estimateHours(s, q);
      if (est != null) return est;
      return startHours(s) + q / (isFastByName(s) ? 20000 : 1000);
    };
    var quality = qualityScore;
    var value = function (s) { var k = quality(s); return s.rate * (k >= 0 ? 1 / (1 + 0.3 * k) : 1 + 0.3 * -k); };

    var cheap = pool.slice().sort(function (a, b) {
      return a.rate - b.rate || speedRank(a) - speedRank(b) || quality(b) - quality(a);
    })[0];
    var others = pool.filter(function (s) { return s !== cheap; });

    // "Very fast" must be clearly faster: at least 10% and 15 minutes sooner for this quantity.
    var fast = others.filter(function (s) { return speedRank(s) < speedRank(cheap) * 0.9 && speedRank(cheap) - speedRank(s) >= 0.25; })
      .sort(function (a, b) { return speedRank(a) - speedRank(b) || a.rate - b.rate; })[0] || null;

    // "Smart" is a better product for a price close to the cheapest one.
    var smart = others.filter(function (s) { return s !== fast && quality(s) > quality(cheap) && s.rate <= cheap.rate * 2.5; })
      .sort(function (a, b) { return value(a) - value(b) || a.rate - b.rate; })[0] || null;

    var bar = Math.max(quality(cheap), smart ? quality(smart) : -Infinity, fast ? quality(fast) : -Infinity);
    var best = others.filter(function (s) { return s !== smart && s !== fast && quality(s) > bar; })
      .sort(function (a, b) { return quality(b) - quality(a) || a.rate - b.rate; })[0] || null;

    var out = [{ key: 'cheap', label: 'Cheapest', service: cheap, alsoFastest: !fast && others.length > 0 }];
    if (smart) out.push({ key: 'smart', label: 'Smart choice', service: smart });
    if (fast) out.push({ key: 'fast', label: 'Very fast', service: fast });
    if (best) out.push({ key: 'best', label: 'Best quality', service: best });
    out.forEach(function (o) {
      o.estimateHours = estimateHours(o.service, q);
      o.refill = refillInfo(o.service);
      o.fits = fitsQuantity(o.service, qty);
      o.outOfRange = outOfRange;
    });
    return out;
  }

  function formatHours(h) {
    if (h == null || !isFinite(h)) return null;
    if (h < 1) return 'under 1 hour';
    if (h < 24) { var r = Math.ceil(h); return r + (r === 1 ? ' hour' : ' hours'); }
    var d = Math.ceil(h / 24);
    return d + (d === 1 ? ' day' : ' days');
  }

  return {
    serviceType: serviceType,
    speedPerHour: speedPerHour,
    startHours: startHours,
    refillInfo: refillInfo,
    features: features,
    qualityScore: qualityScore,
    estimateHours: estimateHours,
    fitsQuantity: fitsQuantity,
    pickOptions: pickOptions,
    formatHours: formatHours,
    plain: plain,
    parseMoney: parseMoney,
    parseJson: parseJson,
    parseTable: parseTable,
    parseCsv: parseCsv,
    parseAny: parseAny,
    normaliseService: normaliseService,
    groupByCategory: groupByCategory,
    platformOf: platformOf,
    quote: quote,
    quantityForBudget: quantityForBudget,
    retailRate: retailRate,
    niceRate: niceRate,
    exactCharge: exactCharge,
    formatPrice: formatPrice,
    formatMoney: formatMoney,
    toCsv: toCsv,
    round: round
  };
});
