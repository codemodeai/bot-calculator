# SMM Price Calculator

A price calculator for [smmorange.com](https://smmorange.com) services. Open `index.html`.

**Simple calculator (`index.html`).** Four steps:
1. **Platform:** Instagram, YouTube, TikTok, Facebook, Telegram or X.
2. **Service:** Followers, Likes, Views, Subscribers, Members, Comments and so on.
3. **Speed / quality:** up to four options, picked automatically from the services list:
   - **Cheapest:** the lowest price.
   - **Smart choice:** better refill or quality for at most 2.5× the cheapest price.
   - **Very fast:** clearly quicker delivery for your quantity.
   - **Best quality:** the strongest refill and accounts.

   An option only appears when it actually differs from the others. **See all options**
   lists every service in the group.
4. **Quantity:** shows the total price, estimated delivery time, refill and service ID.

Delivery time is estimated from the start time and speed in each service's name (for
example "Start: 0-1 Hours | Speed: 300K/Day"). Some services don't list a speed, and then
the page shows "Speed not listed".

**Advanced calculator (`advanced.html`).** Shows every service, with search, budget mode,
drip-feed runs, reseller markup and discount, currency conversion, a multi-item order
and CSV import/export.

## Price data

`data/services.js` / `data/services.json` hold smmorange.com's services list: 147 services
in 36 categories, fetched from the panel API on 2026-10-03. Rates are per 1000 units in
**INR**. The API doesn't report a currency, but INR is smmorange.com's base currency.

To refresh the prices, run:

```sh
python3 tools/fetch_services.py --api https://smmorange.com/api/v2 --key YOUR_KEY --currency INR
```

Don't commit your API key. The script only writes the services list.

Other ways to load a list:
- In the page, use **Import services** and paste API JSON, a CSV
  (`id,name,category,rate,min,max,...`), a table copied from a panel's services page, or a
  saved `.html` copy. Imported lists are saved in your browser only.
- `python3 tools/fetch_services.py --url <services page>` or `--html saved.html` scrapes a
  classic panel services table.

## How prices are calculated

```
cost  = rate_per_1000 × quantity ÷ 1000 × runs
price = cost × (1 + markup%) × (1 − discount%)
```

- **Quantity** must be between the service's min and max order.
- **Runs** are drip-feed runs and only show for services that support drip-feed.
- **Budget mode** gives the largest quantity your budget buys, rounded down and capped
  at the max order.
- If you set a **display currency**, prices are converted with the exchange rate you enter.

## Using the logic from a bot

`calculator.js` works in both Node and the browser:

```js
const C = require('./calculator');
const { services } = require('./data/services.json');
const svc = C.normaliseService(services.find(s => s.id === '1023'));
C.quote(svc, { quantity: 5000, markup: 30 });   // { price, cost, profit, valid, errors, ... }
C.quantityForBudget(svc, 10);                    // { quantity, affordable }
```

## Tests

```sh
npm test
```

## Deploying to Vercel

The site is static, so there's no build step. `vercel.json` serves the repo root as-is,
and `.vercelignore` leaves out `tools/` and `test/`.

- **From GitHub (recommended):** at vercel.com/new, import `codemodeai/bot-calculator` and
  click **Deploy** without changing any settings. Every push to the default branch then
  redeploys the site.
- **From a terminal:** run `npx vercel --prod` in this folder.
