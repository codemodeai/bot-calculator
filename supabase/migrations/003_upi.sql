-- Wallet recharges by UPI, straight into the store's own bank account: no payment gateway, no fee.
-- Replaces Razorpay (its columns and credit_recharge() are removed).
--
-- Each recharge asks for a unique amount (the rupees the customer picked + 1 to 99 paise) and carries a
-- reference note. The server reads the bank's credit-alert emails from Gmail, keeps only genuine ones
-- (signed by the bank, checked by Gmail) in upi_alerts, and the functions below match them to recharges.
-- A UTR (the 12-digit UPI reference) can only ever credit one recharge.

drop function if exists public.credit_recharge(text, text);

alter table public.recharges drop constraint if exists recharges_paid_amount_check;
alter table public.recharges drop constraint if exists recharges_status_check;
alter table public.recharges
  drop column if exists razorpay_order_id,
  drop column if exists razorpay_payment_id,
  drop column if exists paid_amount;
update public.recharges set status = 'pending' where status = 'created';
alter table public.recharges
  alter column status set default 'pending',
  add constraint recharges_status_check check (status in ('pending', 'paid')),
  add column expected_amount numeric(14, 2) not null check (expected_amount >= 1),  -- what the QR asks for
  add column ref        text not null unique,                                      -- UPI note, e.g. BST7K2Q9XHM
  add column expires_at timestamptz not null,
  add column credited   numeric(14, 2),                                            -- what the bank says was paid
  add column utr        text unique,
  add column bank       text,
  add column payer      text,
  add column matched_by text check (matched_by in ('ref', 'amount', 'utr')),
  add column utr_tries  integer not null default 0;
create index recharges_open_idx on public.recharges (expected_amount) where status = 'pending';

-- Genuine UPI credit alerts read from the bank's emails.
create table public.upi_alerts (
  utr         text primary key check (utr ~ '^[0-9]{12}$'),
  amount      numeric(14, 2) not null check (amount > 0),
  bank        text,
  payer       text,
  ref         text,                                -- our reference note, when the bank email shows it
  received_at timestamptz not null,                -- when Gmail received the email
  recharge_id bigint unique references public.recharges (id),
  created_at  timestamptz not null default now()
);
create index upi_alerts_open_idx on public.upi_alerts (received_at) where recharge_id is null;

-- Where the inbox reader got to, and a throttle so only one reader runs every few seconds.
create table public.upi_sync (
  id           integer primary key default 1 check (id = 1),
  last_run     timestamptz not null default 'epoch',
  last_uid     bigint not null default 0,
  uid_validity bigint not null default 0,
  last_ok      timestamptz,
  last_error   text
);
insert into public.upi_sync default values;

alter table public.upi_alerts enable row level security;
alter table public.upi_sync   enable row level security;
-- No policies on purpose, as in 001: only the server's service role can read or write.

-- Start a recharge: picks a free amount (rupees + 1..99 paise) so the bank alert identifies it.
-- Reopening the same top-up while its QR is still valid returns the same recharge.
create function public.create_upi_recharge(p_user uuid, p_amount numeric, p_ref text, p_minutes integer)
returns table (id bigint, expected_amount numeric, ref text, expires_at timestamptz, created_at timestamptz)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  r public.recharges%rowtype;
  paise integer;
begin
  if p_amount is null or p_amount < 1 or p_amount <> round(p_amount, 2) then
    raise exception 'BAD_AMOUNT';
  end if;
  perform pg_advisory_xact_lock(hashtext('upi_recharge_alloc'));   -- one allocator at a time
  select * into r from public.recharges x
    where x.user_id = p_user and x.status = 'pending' and x.amount = p_amount and x.expires_at > now() + interval '2 minutes'
    order by x.created_at desc limit 1;
  if r.id is not null then
    return query select r.id, r.expected_amount, r.ref, r.expires_at, r.created_at;
    return;
  end if;
  if (select count(*) from public.recharges x where x.user_id = p_user and x.status = 'pending' and x.expires_at > now()) >= 5 then
    raise exception 'TOO_MANY_OPEN';
  end if;
  -- An amount is taken while a recharge could still be matched to it (30 minutes after its QR expires),
  -- or if an unmatched payment of exactly that amount arrived in the last 10 minutes.
  select g into paise from generate_series(1, 99) g
    where not exists (select 1 from public.recharges x
                      where x.status = 'pending' and x.expected_amount = p_amount + g / 100.0
                        and x.expires_at > now() - interval '30 minutes')
      and not exists (select 1 from public.upi_alerts a
                      where a.recharge_id is null and a.amount = p_amount + g / 100.0
                        and a.received_at > now() - interval '10 minutes')
    order by random() limit 1;
  if paise is null then
    raise exception 'NO_FREE_AMOUNT';
  end if;
  insert into public.recharges (user_id, amount, expected_amount, ref, expires_at)
    values (p_user, p_amount, p_amount + paise / 100.0, p_ref, now() + make_interval(mins => p_minutes))
    returning * into r;
  return query select r.id, r.expected_amount, r.ref, r.expires_at, r.created_at;
end;
$$;

-- Credit one recharge from one alert, exactly once each. Returns the new balance, or null if either was used.
-- The wallet gets what the bank says was paid.
create function public.credit_upi(p_recharge bigint, p_utr text, p_by text)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  r public.recharges%rowtype;
  a public.upi_alerts%rowtype;
  bal numeric;
begin
  select * into r from public.recharges where id = p_recharge for update;
  select * into a from public.upi_alerts where utr = p_utr for update;
  if r.id is null or a.utr is null or r.status = 'paid' or a.recharge_id is not null then
    return null;
  end if;
  update public.upi_alerts set recharge_id = r.id where utr = a.utr;
  update public.recharges set status = 'paid', paid_at = now(), credited = a.amount, utr = a.utr,
    bank = a.bank, payer = a.payer, matched_by = p_by
    where id = r.id;
  insert into public.wallets (user_id, balance) values (r.user_id, a.amount)
    on conflict (user_id) do update set balance = public.wallets.balance + excluded.balance, updated_at = now()
    returning balance into bal;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (r.user_id, a.amount, bal, 'recharge', 'UPI ' || a.utr);
  return bal;
end;
$$;

-- Match unmatched alerts to open recharges: by reference note first, then by the unique amount.
-- An alert counts if Gmail received it from 2 minutes before the QR was made until 30 minutes after it expired.
create function public.match_upi_alerts()
returns integer
language plpgsql
set search_path = public
as $$
declare
  a public.upi_alerts%rowtype;
  rid bigint;
  how text;
  n integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('upi_match'));
  for a in select * from public.upi_alerts u
           where u.recharge_id is null and u.received_at > now() - interval '3 days'
           order by u.received_at
  loop
    rid := null;
    if a.ref is not null then
      select x.id into rid from public.recharges x
        where x.status = 'pending' and x.ref = a.ref
          and a.received_at between x.created_at - interval '2 minutes' and x.expires_at + interval '30 minutes';
      how := 'ref';
    end if;
    if rid is null then
      select min(x.id) into rid from public.recharges x
        where x.status = 'pending' and x.expected_amount = a.amount
          and a.received_at between x.created_at - interval '2 minutes' and x.expires_at + interval '30 minutes'
        having count(*) = 1;
      how := 'amount';
    end if;
    if rid is not null and public.credit_upi(rid, a.utr, how) is not null then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

-- Save alerts read from the inbox (repeats are ignored) and match them. Returns how many recharges were credited.
create function public.ingest_upi_alerts(p_alerts jsonb)
returns integer
language plpgsql
set search_path = public
as $$
begin
  insert into public.upi_alerts (utr, amount, bank, payer, ref, received_at)
    select e->>'utr', (e->>'amount')::numeric, left(e->>'bank', 60), left(e->>'payer', 120), nullif(e->>'ref', ''),
           least((e->>'received_at')::timestamptz, now())
    from jsonb_array_elements(coalesce(p_alerts, '[]'::jsonb)) e
    where e->>'utr' ~ '^[0-9]{12}$' and e->>'amount' ~ '^[0-9]+(\.[0-9]{1,2})?$'
  on conflict (utr) do nothing;
  return public.match_upi_alerts();
end;
$$;

-- "I've paid": the customer gives the UTR from their UPI app. It only credits if a genuine bank alert with that
-- UTR arrived (within 48 hours of the QR expiring) and hasn't been used. Five tries per recharge.
-- Returns 'paid', 'not_found' or 'used'.
create function public.claim_upi_utr(p_user uuid, p_recharge bigint, p_utr text)
returns text
language plpgsql
set search_path = public
as $$
declare
  r public.recharges%rowtype;
  a public.upi_alerts%rowtype;
begin
  select * into r from public.recharges where id = p_recharge and user_id = p_user for update;
  if r.id is null then
    raise exception 'RECHARGE_NOT_FOUND';
  end if;
  if r.status = 'paid' then
    return 'paid';
  end if;
  if r.utr_tries >= 5 then
    raise exception 'TOO_MANY_TRIES';
  end if;
  update public.recharges set utr_tries = utr_tries + 1 where id = r.id;
  select * into a from public.upi_alerts where utr = p_utr;
  if a.utr is null or a.received_at not between r.created_at - interval '2 minutes' and r.expires_at + interval '48 hours' then
    return 'not_found';
  end if;
  if a.recharge_id is not null then
    return 'used';
  end if;
  perform public.credit_upi(r.id, a.utr, 'utr');
  return 'paid';
end;
$$;

-- Inbox reader throttle: returns a row (where to continue from) only if no reader ran in the last p_min_seconds.
create function public.claim_upi_sync(p_min_seconds integer)
returns table (last_uid bigint, uid_validity bigint)
language sql
set search_path = public
as $$
  update public.upi_sync s set last_run = now()
    where s.id = 1 and s.last_run < now() - make_interval(secs => p_min_seconds)
    returning s.last_uid, s.uid_validity;
$$;

create function public.finish_upi_sync(p_last_uid bigint, p_uid_validity bigint, p_error text)
returns void
language sql
set search_path = public
as $$
  update public.upi_sync set
    last_uid     = case when p_last_uid is null then last_uid
                        when p_uid_validity = uid_validity then greatest(last_uid, p_last_uid)
                        else p_last_uid end,
    uid_validity = coalesce(p_uid_validity, uid_validity),
    last_ok      = case when p_error is null then now() else last_ok end,
    last_error   = left(p_error, 300)
  where id = 1;
$$;

-- Only the server may call these.
revoke all on function public.create_upi_recharge(uuid, numeric, text, integer) from public, anon, authenticated;
revoke all on function public.credit_upi(bigint, text, text) from public, anon, authenticated;
revoke all on function public.match_upi_alerts() from public, anon, authenticated;
revoke all on function public.ingest_upi_alerts(jsonb) from public, anon, authenticated;
revoke all on function public.claim_upi_utr(uuid, bigint, text) from public, anon, authenticated;
revoke all on function public.claim_upi_sync(integer) from public, anon, authenticated;
revoke all on function public.finish_upi_sync(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.create_upi_recharge(uuid, numeric, text, integer) to service_role;
grant execute on function public.credit_upi(bigint, text, text) to service_role;
grant execute on function public.match_upi_alerts() to service_role;
grant execute on function public.ingest_upi_alerts(jsonb) to service_role;
grant execute on function public.claim_upi_utr(uuid, bigint, text) to service_role;
grant execute on function public.claim_upi_sync(integer) to service_role;
grant execute on function public.finish_upi_sync(bigint, bigint, text) to service_role;
