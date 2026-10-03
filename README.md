# SMM Price Calculator

A calculator for the services list on an SMM panel's `/services` page, such as
[smmorange.com/services](https://smmorange.com/services). Pick a service and enter a
quantity or a budget. It checks the service's min/max order and gives the total price.
You can also add a reseller markup, a customer discount and a display currency, and
build an order with several services.

Open `index.html` in a browser. It doesn't need a build step or a server.

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
