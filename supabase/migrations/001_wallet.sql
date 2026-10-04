-- Wallet store: customers recharge a balance with Razorpay, orders are paid from it at the exact price.
-- Only the server (service role) touches these tables; the browser goes through /api/*.

create table public.wallets (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  balance    numeric(14, 4) not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

create table public.recharges (
  id                  bigint generated always as identity primary key,
  user_id             uuid not null references auth.users (id) on delete cascade,
  razorpay_order_id   text not null unique,
  razorpay_payment_id text unique,
  amount              numeric(14, 2) not null check (amount >= 1),
  status              text not null default 'created' check (status in ('created', 'paid')),
  created_at          timestamptz not null default now(),
  paid_at             timestamptz
);
create index recharges_user_idx on public.recharges (user_id, created_at desc);

create table public.orders (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users (id) on delete cascade,
  service_id   text not null,
  title        text not null,
  link         text not null,
  quantity     integer not null check (quantity > 0),
  charge       numeric(14, 4) not null check (charge > 0),   -- what the customer paid from the wallet
  cost         numeric(14, 4),                               -- panel price at the time, for your margin
  status       text not null default 'placing' check (status in ('placing', 'placed', 'refunded', 'checking')),
  smm_order    text,
  error        text,
  created_at   timestamptz not null default now()
);
create index orders_user_idx on public.orders (user_id, created_at desc);

-- Every balance change, for support and accounting.
create table public.ledger (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  delta         numeric(14, 4) not null,
  balance_after numeric(14, 4) not null,
  kind          text not null check (kind in ('recharge', 'order', 'refund', 'adjust')),
  ref           text,
  created_at    timestamptz not null default now()
);
create index ledger_user_idx on public.ledger (user_id, created_at desc);

alter table public.wallets   enable row level security;
alter table public.recharges enable row level security;
alter table public.orders    enable row level security;
alter table public.ledger    enable row level security;
-- No policies on purpose: anon/authenticated keys can't read or write anything; the service role bypasses RLS.

-- Credit a paid recharge exactly once. Returns the new balance.
create function public.credit_recharge(p_razorpay_order_id text, p_payment_id text)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  r public.recharges%rowtype;
  bal numeric;
begin
  select * into r from public.recharges where razorpay_order_id = p_razorpay_order_id for update;
  if not found then
    raise exception 'RECHARGE_NOT_FOUND';
  end if;
  if r.status = 'paid' then
    select balance into bal from public.wallets where user_id = r.user_id;
    return coalesce(bal, 0);
  end if;
  update public.recharges set status = 'paid', razorpay_payment_id = p_payment_id, paid_at = now() where id = r.id;
  insert into public.wallets (user_id, balance) values (r.user_id, r.amount)
    on conflict (user_id) do update set balance = public.wallets.balance + excluded.balance, updated_at = now()
    returning balance into bal;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (r.user_id, r.amount, bal, 'recharge', p_payment_id);
  return bal;
end;
$$;

-- Take the exact charge from the wallet and record the order, or fail with INSUFFICIENT_FUNDS.
create function public.place_order(p_user uuid, p_service_id text, p_title text, p_link text,
                                   p_quantity integer, p_charge numeric, p_cost numeric)
returns table (order_id bigint, balance numeric)
language plpgsql
set search_path = public
as $$
declare
  bal numeric;
  oid bigint;
begin
  if p_charge is null or p_charge <= 0 then
    raise exception 'BAD_CHARGE';
  end if;
  update public.wallets w set balance = w.balance - p_charge, updated_at = now()
    where w.user_id = p_user and w.balance >= p_charge
    returning w.balance into bal;
  if not found then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;
  insert into public.orders (user_id, service_id, title, link, quantity, charge, cost)
    values (p_user, p_service_id, p_title, p_link, p_quantity, p_charge, p_cost)
    returning id into oid;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (p_user, -p_charge, bal, 'order', oid::text);
  return query select oid, bal;
end;
$$;

-- The panel accepted the order.
create function public.finish_order(p_order bigint, p_smm_order text)
returns void
language sql
set search_path = public
as $$
  update public.orders set status = 'placed', smm_order = p_smm_order, error = null where id = p_order and status = 'placing';
$$;

-- The panel refused (refund = true: money goes back) or didn't answer (refund = false: check by hand).
create function public.fail_order(p_order bigint, p_error text, p_refund boolean)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  o public.orders%rowtype;
  bal numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if not found or o.status <> 'placing' then
    return null;
  end if;
  if not p_refund then
    update public.orders set status = 'checking', error = p_error where id = p_order;
    return null;
  end if;
  update public.wallets set balance = balance + o.charge, updated_at = now() where user_id = o.user_id returning balance into bal;
  update public.orders set status = 'refunded', error = p_error where id = p_order;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (o.user_id, o.charge, bal, 'refund', p_order::text);
  return bal;
end;
$$;

-- Only the server may call these.
revoke all on function public.credit_recharge(text, text) from public, anon, authenticated;
revoke all on function public.place_order(uuid, text, text, text, integer, numeric, numeric) from public, anon, authenticated;
revoke all on function public.finish_order(bigint, text) from public, anon, authenticated;
revoke all on function public.fail_order(bigint, text, boolean) from public, anon, authenticated;
grant execute on function public.credit_recharge(text, text) to service_role;
grant execute on function public.place_order(uuid, text, text, text, integer, numeric, numeric) to service_role;
grant execute on function public.finish_order(bigint, text) to service_role;
grant execute on function public.fail_order(bigint, text, boolean) to service_role;
