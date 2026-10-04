# Boostly store

A store for SMM panel services, buying from [smmzio.com](https://smmzio.com). Customers add money to a wallet by
**UPI, straight into your bank account** (no payment gateway, no fee), order at exact prices, and orders go to the
panel automatically.

The store is the home page (`index.html`), laid out as a dashboard:

| Column | What it does |
|---|---|
| Sidebar | New order, My orders, Add money; Settings, Help & Support, sign in/out, profile and wallet at the bottom |
| Platform rail | Instagram, TikTok, YouTube, Facebook, Telegram, X and any other platform the panel sells |
| Categories | What the service does: Followers, Likes, Views, Comments, Shares, Saves, Story views… |
| Services | Every service in the category, sortable by cheapest, fastest or quality. The automatic picks are tagged **Starter**, **Popular**, **Express** and **Premium** |
| Service details | Price per 1,000, delivery estimate, start time, speed, refill, min/max |
| Place order | Link, wallet balance, Place order, and the customer's stats |
| Price calculator | Quantity, price per 1,000, delivery estimate and exact total |

On wide screens the price calculator has its own column on the far right; on narrower screens it sits above
Place order, and on phones everything stacks with a bottom menu. The **Light / Dark** switch is in the top-right
corner and is remembered in the browser.

Customers pay from a **wallet**: they sign in with their email, add money once by UPI
(minimum ₹1), and every order then takes its **exact price** from the balance, even ₹0.24 for
1,000 views. **My orders** (`/#orders`) shows the balance, money added, and each order's live
delivery status from the panel.

Delivery time is estimated from the start time and speed in each service's name (for example
"Start: 0-1 Hours | Speed: 300K/Day").

## Prices

Prices come **live from your smmzio.com account** through `SMM_API_KEY`: the panel's
services list (`action=services`), refreshed every 5 minutes.

```
rate per 1000 = panel rate × (1 + MARKUP_PERCENT ÷ 100), rounded up to a tidy number
price         = rate per 1000 × quantity ÷ 1000
```

Example: a ₹0.16 panel rate × 1.8 = ₹0.288, shown as **₹0.30 per 1,000**. smmzio prices are in USD and
are converted with `PANEL_TO_INR_RATE` first.

Orders cost exactly that, rounded up to 1/100 of a paisa (₹0.0001); there's no minimum order.
Only adding money has a minimum (₹1). `MARKUP_PERCENT` defaults to 80. Tidy rounding goes up in steps of
₹0.05 under ₹1, ₹0.10 under ₹10, ₹1 under ₹100 and ₹5 above; set `ROUND_PRICES=0` to turn it off.
Set `MARKUP_PERCENT=0` and `ROUND_PRICES=0` to sell at exactly the panel price.

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
panel accepted the key, the panel currency, how many services loaded and when the bank-alert inbox
was last read. `?check=1` reads the inbox right now. It never shows the keys or your balance.

## Wallet and payments

```
add money:  customer --scans QR / taps UPI app--> pays ₹100.37 into YOUR bank account
            your bank --credit alert email--> your Gmail <--reads (IMAP, read-only)-- /api/recharge
            genuine alert, amount ₹100.37 (or the note BST…) --> matched --> wallet +₹100.37
order:      customer --> /api/order --> exact price taken from wallet --> smmzio.com API (action=add)
            panel refuses (e.g. low balance) --> price goes straight back to the wallet
```

### How UPI payments work

1. The customer picks an amount (say ₹100). The store makes a **UPI QR and payment link** for a unique
   amount, ₹100 plus 1 to 99 paise (₹100.37), with a reference note like `BSTK7Q2M9XH`. No two open
   payments ever share an amount. The QR is valid for 10 minutes (`UPI_QR_MINUTES`).
2. The customer scans it with Google Pay, PhonePe, Paytm, BHIM or any UPI app (on phones they tap their
   app instead). The money goes **straight into your bank account**: no gateway, no fee, no settlement wait.
3. Your bank emails you a credit alert. The checkout asks the server every few seconds; the server reads
   new emails from your Gmail inbox (at most once every 8 seconds, however many customers are waiting).
4. A genuine alert for exactly ₹100.37 (or one that shows the reference note) credits **₹100.37** to the
   wallet and the checkout shows the success animation. Customers get every rupee they paid.
5. If the customer changed the amount in their app, or the bank's email is slow, they can tap
   **Paid but still waiting? Enter your UTR** and type the 12-digit UPI reference from their app. It
   still only counts once a genuine bank alert with that UTR has arrived; 5 tries per payment.
6. If they close the page after paying, the money is added on their next visit (up to 30 minutes after
   the QR expires automatically; with the UTR, up to 48 hours).

**Fake emails don't work.** Anyone can email you "Rs 100.37 credited". An alert only counts if all of
these are true:

- the From address is a bank: `UPI_ALERT_SENDERS`, which defaults to the common Indian banks plus any
  `*.bank.in` domain (only RBI-regulated banks can register those);
- Gmail's own check, the top `Authentication-Results` header it adds on arrival, says the bank's DKIM
  signature or DMARC **passed** for that same domain (headers a sender plants further down are ignored);
- it reads as a credit, not a debit, with an amount and a 12-digit UTR.

Each UTR can credit only one payment, ever. The inbox is opened read-only: nothing is marked read,
moved or deleted.

### Setting up UPI payments

1. **Your UPI ID**: the one your money should land in, e.g. `yourname@okhdfcbank`. A business/merchant
   UPI ID (PhonePe Business, Paytm for Business, Google Pay for Business, BharatPe…) is best: personal UPI
   IDs have lower daily limits, and some apps limit payments to personal IDs from links.
2. **Bank alerts by email**: turn on email alerts for UPI credits in your bank's app or net banking, sent to a
   Gmail address. Best: a **new Gmail account used only for this**, either as the bank's registered email or
   with a Gmail filter forwarding the bank's alerts to it.
3. **Gmail app password** for that account: turn on 2-Step Verification, then Google Account → Security →
   App passwords → create one (16 characters). IMAP is on by default for new accounts; if not, Gmail →
   Settings → Forwarding and POP/IMAP → Enable IMAP.
4. **Database**: run `supabase/migrations/003_upi.sql` in the Supabase SQL editor (after 001 and 002).
5. **Vercel**: set `UPI_ID`, `UPI_NAME`, `GMAIL_ADDRESS` and `GMAIL_APP_PASSWORD`, and redeploy.
6. **Test**: add ₹1 to a wallet from the store and pay it. If it doesn't go through, open
   `/api/status?check=1` to see whether Gmail accepted the password and when the inbox was last read.
   If your bank's alerts come from a domain that isn't on the default list, set `UPI_ALERT_SENDERS` to it
   (for example `alerts@hdfcbank.net` or `sbi.co.in`). Setting it to your own bank is safest anyway.

Bank emails usually arrive within seconds, but some banks take a few minutes. Your bank's emails must
show the amount and the UTR (UPI reference number); all major Indian banks' UPI credit alerts do.

### The other services

- **SMM panel API key** (smmzio.com → Account → API). It loads prices, places orders, and pays
  for them from your panel balance.
- **Supabase** (supabase.com) keeps customer logins and wallets. Create a project, run
  the files in `supabase/migrations/` in order in its SQL editor, and copy the URL and keys from
  Project Settings → API.

Set them as environment variables: in Vercel → Project → Settings → Environment Variables, or in a
local `.env` copied from `.env.example`. After changing them in Vercel, redeploy. **Never put keys
in the code or commit them.**

| Variable | |
|---|---|
| `SMM_API_KEY` | smmzio.com API key |
| `SMM_API_URL` | defaults to `https://smmzio.com/api/v2` (any Perfect Panel–style API works) |
| `UPI_ID` | the UPI ID customers pay, e.g. `yourname@okhdfcbank` |
| `UPI_NAME` | the name their UPI app shows (defaults to `STORE_NAME`) |
| `GMAIL_ADDRESS` | the Gmail inbox that receives your bank's UPI credit alerts |
| `GMAIL_APP_PASSWORD` | a 16-character Google App Password for it (not your Gmail password) |
| `UPI_ALERT_SENDERS` | optional: your bank's alert address or domain, comma-separated (default: common Indian banks) |
| `UPI_QR_MINUTES` | how long a payment QR stays valid (default `10`) |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | Supabase project URL and public (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key, server only |
| `MARKUP_PERCENT` | your margin on top of the panel price (default `80`) |
| `ROUND_PRICES` | round prices up to tidy numbers, e.g. ₹0.288 → ₹0.30 (default on; `0` = off) |
| `PANEL_TO_INR_RATE` | rupees per 1 unit of the panel's currency; smmzio is in USD, so e.g. `98` |
| `STORE_NAME`, `SUPPORT_CONTACT` | shown in the store |
| `ADMIN_EMAILS` | optional: emails that are always admin-panel owners, comma-separated (more can be added in the panel) |

Unless all of the panel, UPI, Gmail and Supabase keys are set, the store runs in **demo mode**: a
pretend wallet kept in the visitor's browser, a sample QR that can't be paid with a **Simulate a
payment** button, and no order is ever placed.

**Sign-in page:** customers sign in on a full-screen page with a 6-digit email code (no password) or
**Continue with Google**. Signed-in customers get a profile menu in the top right (wallet, My orders,
Settings, Help, **Log out**); logging out asks to confirm first.

**Google sign-in** (optional; the Google button stays greyed out until it's on):

1. Google Cloud Console → APIs & Services → **OAuth consent screen**: set it up as External with your store
   name and email.
2. **Credentials → Create credentials → OAuth client ID** → Web application. Under *Authorized redirect URIs* add
   `https://ibnvinskryfrkfejxqvl.supabase.co/auth/v1/callback`.
3. Supabase → Authentication → **Sign In / Providers → Google**: turn it on and paste the Client ID and Client
   secret.

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
- Balances change only inside the database functions in `supabase/migrations/` (`001_wallet.sql` for
  orders, `003_upi.sql` for UPI). They lock the rows, so two tabs can't spend the same money, and each
  payment (UTR) is credited once even if several checks see it.
- The wallet tables have row-level security with no public access; only the server's service role
  key can read or change them.
- If the panel refuses an order, the charge goes back to the wallet at once. If the panel doesn't
  answer, the order is marked **Being checked** instead of refunded, because it may have gone
  through; check it on the panel and refund it in the `orders`/`wallets` tables if it didn't.
- Every balance change is recorded in the `ledger` table.

API routes (`api/`, Vercel serverless functions): `GET /api/admin`, `POST /api/admin` (admins only),
`GET/POST /api/tickets`, `GET /api/services`, `GET /api/status`,
`GET /api/wallet`, `POST /api/recharge` (new payment, or `{ id, utr }`), `GET /api/recharge?id=…` (payment
status), `POST /api/order`, `GET /api/order-status?id=…`.

## Admin panel and support tickets

**`/admin`** is the store's back office. It shows:

| Page | What's there |
|---|---|
| Overview | Profit and margin, money in by UPI, order revenue, provider (smmzio) cost, accounts, money held in wallets, your smmzio balance (warns when low), revenue-per-day chart, and alerts for anything that needs you |
| Orders | Every order with paid / cost / profit; check live status on the panel, refund to the wallet, or mark a "being checked" order as placed |
| Customers | Accounts, sign-in method, wallet, money added and spent; adjust a wallet (with a reason saved in the ledger) |
| Payments | UPI top-ups, inbox status, **Check inbox now**, and bank payments that matched no top-up, which you can credit to a customer |
| Tickets | Customers' support tickets; read, reply, close or reopen |
| Team & access | Who can open the admin panel; owners add or remove people |

**Who can open it:** only people on the team. Each request checks, on the server, that the signed-in
email is verified and listed in the `admins` table (owner or staff) or in the `ADMIN_EMAILS` environment
variable (always an owner). Everyone else gets "No access" and no data. Admins see an **Admin panel** item in
their profile menu in the store; customers never do. Sign in at `/?signin=admin` to go straight to the panel.
Add `https://YOUR-SITE/**` under Supabase → Authentication → URL Configuration → Redirect URLs so Google
sign-in can return to `/admin`.

- **Owners** see everything and can add or remove admins.
- **Staff** see everything and handle orders, payments and tickets, but can't change who has access.

**Support tickets:** customers open tickets from **Help & Support** in the store, optionally about a
specific order ("Get help with this order" in My orders). Replies from the admin panel appear in the
customer's ticket with a red dot until they read it. Customers see replies as "*Store name* support", never
the staff member's email.

Run `supabase/migrations/004_admin.sql` (after 001–003) to add the admin and ticket tables.

## Running locally

```sh
cp .env.example .env     # add your keys
node dev-server.js       # http://localhost:3000
npm test
```

## Deploying to Vercel

There's no build step. Vercel installs the three server packages (`imapflow` reads Gmail, `mailparser`
reads the emails, `qrcode` draws the QR) with `npm ci`, then `vercel.json` serves the repo root and the
`api/` functions; `.vercelignore` leaves out `tools/`, `test/`, `supabase/`, `dev-server.js` and `.env`.

At vercel.com/new, import `codemodeai/bot-calculator` and click **Deploy** without changing any
settings. Every push to the default branch then redeploys the site; other branches get preview
links.
