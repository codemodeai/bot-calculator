# Boostly store

A store for [smmorange.com](https://smmorange.com) services. Customers add money to a wallet with
Razorpay (UPI, cards, netbanking), order at exact prices, and orders go to smmorange.com automatically.

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
5. **Link** to the profile or post, then **Place order**.

Customers pay from a **wallet**: they sign in with their email, add money once with Razorpay
(minimum ₹1), and every order then takes its **exact price** from the balance, even ₹0.24 for
1,000 views. **My orders** (`/#orders`) shows the balance, money added, and each order's live
delivery status from the panel.

Delivery time is estimated from the start time and speed in each service's name (for example
"Start: 0-1 Hours | Speed: 300K/Day").

## Prices

Prices come **live from your smmorange.com account** through `SMM_API_KEY`: the panel's
services list (`action=services`), refreshed every 5 minutes.

```
price = panel rate per 1000 × quantity ÷ 1000 × (1 + MARKUP_PERCENT ÷ 100)
```

Orders cost exactly that, rounded up to 1/100 of a paisa (₹0.0001); there's no minimum order.
Only adding money has a minimum (₹1, Razorpay's smallest payment). `MARKUP_PERCENT` defaults to 50. Set it
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

## Wallet and payments

```
add money:  customer --pays ≥ ₹1--> Razorpay --> /api/recharge (checks signature) --> wallet balance
order:      customer --> /api/order --> exact price taken from wallet --> smmorange.com API (action=add)
            panel refuses (e.g. low balance) --> price goes straight back to the wallet
```

Three services are involved:

- **SMM panel API key** (smmorange.com → Account → API). It loads prices, places orders, and pays
  for them from your panel balance.
- **Razorpay keys** (dashboard.razorpay.com → Account & Settings → API Keys). Customers add money
  to their wallet with these. Start with `rzp_test_...` keys, then switch to live keys once
  Razorpay activates your account.
- **Supabase** (supabase.com) keeps customer logins and wallets. Create a project, run
  `supabase/migrations/001_wallet.sql` in its SQL editor, and copy the URL and keys from
  Project Settings → API.

Set them as environment variables: in Vercel → Project → Settings → Environment Variables, or in a
local `.env` copied from `.env.example`. After changing them in Vercel, redeploy. **Never put keys
in the code or commit them.**

| Variable | |
|---|---|
| `SMM_API_KEY` | smmorange.com API key |
| `SMM_API_URL` | defaults to `https://smmorange.com/api/v2` |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Razorpay API keys |
| `RAZORPAY_WEBHOOK_SECRET` | optional backup: add a webhook to `https://YOUR-SITE/api/webhook` for `payment.captured` |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project URL and public (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key, server only |
| `MARKUP_PERCENT` | your margin on top of the panel price (default `50`) |
| `PANEL_TO_INR_RATE` | only if your panel account isn't in INR |
| `STORE_NAME`, `SUPPORT_CONTACT` | shown in the store |

Unless all of the panel, Razorpay and Supabase keys are set, the store runs in **demo mode**: a
pretend wallet kept in the visitor's browser, and no order is ever placed.

**Supabase sign-in settings** (Authentication in the Supabase dashboard):

- **URL Configuration → Site URL**: your store address, e.g. `https://your-project.vercel.app`.
  Also add it under Redirect URLs.
- **Emails → Magic Link** template: include `{{ .Token }}` so the email has the 6-digit code,
  e.g. `Your Boostly code is {{ .Token }}`. Without it customers can still tap the link in the email.
- Supabase's built-in email sender only allows a few emails per hour. Before launch, connect your
  own SMTP (Authentication → Emails → SMTP Settings), for example Resend, Brevo or Amazon SES.

How it stays safe:

- The server works out every price from the live panel price plus your markup. The browser only
  sends the service, quantity and link.
- Balances change only inside the database functions in `supabase/migrations/001_wallet.sql`.
  They lock the wallet row, so two tabs can't spend the same money, and a recharge is credited
  once even if the page and the webhook both report it.
- The wallet tables have row-level security with no public access; only the server's service role
  key can read or change them.
- If the panel refuses an order, the charge goes back to the wallet at once. If the panel doesn't
  answer, the order is marked **Being checked** instead of refunded, because it may have gone
  through; check it on smmorange and refund it in the `orders`/`wallets` tables if it didn't.
- Every balance change is recorded in the `ledger` table.

API routes (`api/`, Vercel serverless functions): `GET /api/services`, `GET /api/status`,
`GET /api/wallet`, `POST /api/recharge`, `POST /api/order`, `GET /api/order-status?id=…`,
`POST /api/webhook`.

## Running locally

```sh
cp .env.example .env     # add your keys
node dev-server.js       # http://localhost:3000
npm test
```

## Deploying to Vercel

There's no build step. `vercel.json` serves the repo root and the `api/` functions, and
`.vercelignore` leaves out `tools/`, `test/`, `supabase/`, `dev-server.js` and `.env`.

At vercel.com/new, import `codemodeai/bot-calculator` and click **Deploy** without changing any
settings. Every push to the default branch then redeploys the site; other branches get preview
links.
