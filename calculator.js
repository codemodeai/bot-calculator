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

  return {
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
    formatMoney: formatMoney,
    toCsv: toCsv,
    round: round
  };
});
