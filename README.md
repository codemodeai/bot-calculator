# SMM Price Calculator

A store and price calculator for [smmorange.com](https://smmorange.com) services.

**Simple calculator (`calculator.html`, served at `/calculator`).** Four steps:
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

**Store (`index.html`, the home page).** A shop for your customers: platform → service →
package → quantity → link → **Pay with Razorpay** (UPI, cards, netbanking). After payment the order
is placed on smmorange.com automatically, and the customer gets a tracking ID for `/#track`.
See [Store and payments](#store-and-payments).

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

## Store and payments

```
customer --pays--> Razorpay --> /api/verify-payment --checks signature--> smmorange.com API (action=add)
                                     ^                                     paid from your panel balance
               /api/webhook (backup if the customer closes the tab)
```

Two different keys are involved:

- **SMM panel API key** (smmorange.com → Account → API). It places orders and pays for them from
  your panel balance. It can't take money from customers.
- **Razorpay keys** (dashboard.razorpay.com → Account & Settings → API Keys). These take the
  customer's payment. Start with `rzp_test_...` keys, then switch to live keys once Razorpay
  activates your account.

Set them as environment variables: in Vercel → Project → Settings → Environment Variables, or in a
local `.env` copied from `.env.example`. **Never put keys in the code or commit them.**

| Variable | |
|---|---|
| `SMM_API_KEY` | smmorange.com API key |
| `SMM_API_URL` | defaults to `https://smmorange.com/api/v2` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys |
| `RAZORPAY_WEBHOOK_SECRET` | optional backup: add a webhook to `https://YOUR-SITE/api/webhook` for `payment.captured` |
| `MARKUP_PERCENT` | your margin on top of the panel price (default `50`) |
| `STORE_NAME`, `SUPPORT_CONTACT` | shown in the store |

Unless both Razorpay keys **and** the panel key are set, the store runs in **demo mode**: checkout
is simulated and no order is ever placed.

How it stays safe:

- The server works out the price from the panel price plus your markup. It ignores any price the
  browser sends and asks Razorpay for exactly that amount.
- The order details (service, link, quantity) are saved on the Razorpay order. After payment they
  are read back from there, not from the browser.
- The panel order is placed only after the Razorpay signature checks out and the payment is
  captured. The panel order ID is saved in the Razorpay payment's notes, so a retry or the webhook
  never orders twice.
- When the panel key is set, live panel prices are used (cached for 10 minutes). If the panel
  raises a price, the store charges the new price, so you don't sell at a loss.
- If the panel refuses an order (for example, low balance), the customer sees their payment
  reference, and the reason is saved on the payment in Razorpay (`smm_error` note). Top up your
  balance and place the order by hand, or refund it from the Razorpay dashboard.

API routes (`api/`, Vercel serverless functions): `GET /api/services`, `POST /api/create-order`,
`POST /api/verify-payment`, `GET /api/order-status?id=pay_…`, `POST /api/webhook`.

To run it locally, run `node dev-server.js` and open http://localhost:3000.

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
