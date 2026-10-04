-- What the customer actually paid Razorpay (wallet credit + Razorpay fee). The wallet is credited `amount`.
alter table public.recharges add column paid_amount numeric(14, 2);
alter table public.recharges add constraint recharges_paid_amount_check check (paid_amount is null or paid_amount >= amount);
