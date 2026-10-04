# Boostly store

A store for [smmorange.com](https://smmorange.com) services. Customers pick a service, pay with
Razorpay (UPI, cards, netbanking), and the order is placed on smmorange.com automatically.

The store is the home page (`index.html`). The steps:

1. **Platform:** Instagram, YouTube, TikTok, Facebook, Telegram or X.
2. **Service:** Followers, Likes, Views, Subscribers, Members, Comments and so on.
3. **Package:** up to four, picked automatically from the panel's services:
   - **Starter:** the lowest price.
   - **Popular:** better refill or quality for at most 2.5× the cheapest price.
   - **Express:** clearly quicker delivery for the chosen quantity.
   - **Premium:** the strongest refill and accounts.

   A package only appears when it actually differs from the others. **See all options** lists
   every service in the group, cheapest first.
4. **Quantity**, within the service's min and max order.
5. **Link** to the profile or post, then **Pay**.

After payment the customer gets a tracking ID. **Track order** (`/#track`) shows the live delivery
status from the panel.

Delivery time is estimated from the start time and speed in each service's name (for example
"Start: 0-1 Hours | Speed: 300K/Day").

## Prices

Prices come **live from your smmorange.com account** through `SMM_API_KEY`: the panel's
services list (`action=services`), refreshed every 5 minutes.

```
price = panel rate per 1000 × quantity ÷ 1000 × (1 + MARKUP_PERCENT ÷ 100)
```

Prices are rounded up to the paisa, with a ₹1 minimum. `MARKUP_PERCENT` defaults to 50. Set it
to `0` to sell at exactly the panel price.

- The footer of the store says **Live prices · updated HH:MM** when the prices come from your
  panel.
- If the panel rejects the key or can't be reached, the store shows the error instead of guessing
  prices. During a short outage (under an hour) it keeps using the last live prices.
- The panel's account currency is read with `action=balance`. If it isn't INR, set
  `PANEL_TO_INR_RATE` (rupees per 1 unit of that currency); the store won't quote without it.
- Without `SMM_API_KEY` the store runs in demo mode with the sample list in `data/services.json`.
  Refresh that file with
  `python3 tools/fetch_services.py --api https://smmorange.com/api/v2 --key YOUR_KEY --currency INR`.

Cost prices never reach the browser: `/api/services` sends only selling prices, and `/data/` and
`/lib/` aren't served.

**Check your setup:** open `https://YOUR-SITE/api/status`. It shows which keys are set, whether the
panel accepted the key, the panel currency and how many services loaded. It never shows the keys
or your balance.

## Payments

```
customer --pays--> Razorpay --> /api/verify-payment --checks signature--> smmorange.com API (action=add)
                                     ^                                     paid from your panel balance
               /api/webhook (backup if the customer closes the tab)
```

Two different keys are involved:

- **SMM panel API key** (smmorange.com → Account → API). It loads prices, places orders, and pays
  for them from your panel balance. It can't take money from customers.
- **Razorpay keys** (dashboard.razorpay.com → Account & Settings → API Keys). These take the
  customer's payment. Start with `rzp_test_...` keys, then switch to live keys once Razorpay
  activates your account.

Set them as environment variables: in Vercel → Project → Settings → Environment Variables, or in a
local `.env` copied from `.env.example`. After changing them in Vercel, redeploy. **Never put keys
in the code or commit them.**

| Variable | |
|---|---|
| `SMM_API_KEY` | smmorange.com API key |
| `SMM_API_URL` | defaults to `https://smmorange.com/api/v2` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys |
| `RAZORPAY_WEBHOOK_SECRET` | optional backup: add a webhook to `https://YOUR-SITE/api/webhook` for `payment.captured` |
| `MARKUP_PERCENT` | your margin on top of the panel price (default `50`) |
| `PANEL_TO_INR_RATE` | only if your panel account isn't in INR |
| `STORE_NAME`, `SUPPORT_CONTACT` | shown in the store |

Unless both Razorpay keys **and** the panel key are set, the store runs in **demo mode**: checkout
is simulated and no order is ever placed.

How it stays safe:

- The server works out the price from the live panel price plus your markup. It ignores any price
  the browser sends and asks Razorpay for exactly that amount.
- The order details (service, link, quantity) are saved on the Razorpay order. After payment they
  are read back from there, not from the browser.
- The panel order is placed only after the Razorpay signature checks out and the payment is
  captured. The panel order ID is saved in the Razorpay payment's notes, so a retry or the webhook
  never orders twice.
- If the panel refuses an order (for example, low balance), the customer sees their payment
  reference, and the reason is saved on the payment in Razorpay (`smm_error` note). Top up your
  balance and place the order by hand, or refund it from the Razorpay dashboard.

API routes (`api/`, Vercel serverless functions): `GET /api/services`, `GET /api/status`,
`POST /api/create-order`, `POST /api/verify-payment`, `GET /api/order-status?id=pay_…`,
`POST /api/webhook`.

## Running locally

```sh
cp .env.example .env     # add your keys
node dev-server.js       # http://localhost:3000
npm test
```

## Deploying to Vercel

There's no build step. `vercel.json` serves the repo root and the `api/` functions, and
`.vercelignore` leaves out `tools/`, `test/`, `dev-server.js` and `.env`.

At vercel.com/new, import `codemodeai/bot-calculator` and click **Deploy** without changing any
settings. Every push to the default branch then redeploys the site; other branches get preview
links.
