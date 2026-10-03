# SMM Price Calculator

A calculator for the services list on an SMM panel's `/services` page, such as
[smmorange.com/services](https://smmorange.com/services). Pick a service and enter a
quantity or a budget. It checks the service's min/max order and gives the total price.
You can also add a reseller markup, a customer discount and a display currency, and
build an order with several services.

Open `index.html` in a browser. It doesn't need a build step or a server.

## Loading the real smmorange.com prices

The repo ships **demo data** (`data/services.js`). These are sample services, **not**
smmorange.com prices. The page shows a warning banner until you load the real list in
one of these ways:

1. **Paste in the page.** Open smmorange.com/services, select the whole table, copy it, then go to
   **Import services**, paste and click **Import**. The list is saved in your browser.
   You can also import:
   - JSON from the panel API (`action=services`)
   - a CSV file (`id,name,category,rate,min,max,...`)
   - a saved copy of the page (`.html`)
2. **Bundle it into the repo** (everyone who opens the page gets it):
   ```sh
   python3 tools/fetch_services.py                       # scrape https://smmorange.com/services
   python3 tools/fetch_services.py --html saved.html     # from a page you saved in your browser
   python3 tools/fetch_services.py --api https://smmorange.com/api/v2 --key YOUR_KEY
   ```
   This rewrites `data/services.json` and `data/services.js`. Run it again whenever the
   panel changes its prices.

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
