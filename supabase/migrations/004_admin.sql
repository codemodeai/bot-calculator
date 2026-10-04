-- Admin panel and support tickets.
--
-- admins: who may open /admin. Owners can add and remove people; staff can use everything else.
-- Owners can also come from the ADMIN_EMAILS environment variable (see lib/admin.js).
-- tickets / ticket_messages: customers' support conversations with the team.
-- The admin_* functions read auth.users (security definer) and are callable only by the server.

create table public.admins (
  email      text primary key check (email = lower(email) and email like '%_@_%'),
  role       text not null default 'staff' check (role in ('owner', 'staff')),
  added_by   text,
  created_at timestamptz not null default now()
);

create table public.tickets (
  id            bigint generated always as identity primary key,
  user_id       uuid not null references auth.users (id) on delete cascade,
  email         text not null,
  subject       text not null check (char_length(subject) between 3 and 140),
  category      text not null default 'other' check (category in ('order', 'payment', 'account', 'other')),
  order_id      bigint references public.orders (id) on delete set null,
  status        text not null default 'open' check (status in ('open', 'answered', 'closed')),
  last_from     text not null default 'customer' check (last_from in ('customer', 'staff')),
  customer_seen boolean not null default true,         -- false = the team replied and the customer hasn't looked yet
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index tickets_user_idx on public.tickets (user_id, updated_at desc);
create index tickets_status_idx on public.tickets (status, updated_at desc);

create table public.ticket_messages (
  id         bigint generated always as identity primary key,
  ticket_id  bigint not null references public.tickets (id) on delete cascade,
  from_staff boolean not null default false,
  author     text,                                     -- staff email; customers only ever see "Support team"
  body       text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index ticket_messages_ticket_idx on public.ticket_messages (ticket_id, id);

alter table public.admins          enable row level security;
alter table public.tickets         enable row level security;
alter table public.ticket_messages enable row level security;
-- No policies: only the server's service role can read or write.

-- ---------- tickets ----------

-- A customer opens a ticket with its first message. At most 5 open tickets per customer.
create function public.create_ticket(p_user uuid, p_email text, p_subject text, p_category text, p_order bigint, p_body text)
returns bigint
language plpgsql
set search_path = public
as $$
declare
  tid bigint;
begin
  if (select count(*) from public.tickets t where t.user_id = p_user and t.status <> 'closed') >= 5 then
    raise exception 'TOO_MANY_TICKETS';
  end if;
  if p_order is not null and not exists (select 1 from public.orders o where o.id = p_order and o.user_id = p_user) then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  insert into public.tickets (user_id, email, subject, category, order_id)
    values (p_user, lower(p_email), btrim(p_subject), coalesce(p_category, 'other'), p_order)
    returning id into tid;
  insert into public.ticket_messages (ticket_id, body) values (tid, btrim(p_body));
  return tid;
end;
$$;

-- Add a message. p_user set = the customer (must own the ticket); p_user null = staff (p_staff = their email).
-- A customer reply reopens the ticket; a staff reply marks it answered and unread for the customer.
create function public.ticket_post(p_ticket bigint, p_user uuid, p_staff text, p_body text)
returns text
language plpgsql
set search_path = public
as $$
declare
  t public.tickets%rowtype;
begin
  select * into t from public.tickets where id = p_ticket for update;
  if t.id is null or (p_user is not null and t.user_id <> p_user) then
    raise exception 'TICKET_NOT_FOUND';
  end if;
  insert into public.ticket_messages (ticket_id, from_staff, author, body)
    values (t.id, p_user is null, case when p_user is null then lower(p_staff) end, btrim(p_body));
  if p_user is null then
    update public.tickets set status = 'answered', last_from = 'staff', customer_seen = false, updated_at = now() where id = t.id;
    return 'answered';
  end if;
  update public.tickets set status = 'open', last_from = 'customer', customer_seen = true, updated_at = now() where id = t.id;
  return 'open';
end;
$$;

-- ---------- admin: numbers ----------

-- Totals since p_from. Revenue and provider cost count orders that went to the panel (placed, or being
-- checked); refunded orders are excluded. Profit = revenue - provider_cost.
create function public.admin_stats(p_from timestamptz)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'money_in',        coalesce((select sum(r.credited) from public.recharges r where r.status = 'paid' and r.paid_at >= p_from), 0),
    'payments',        (select count(*) from public.recharges r where r.status = 'paid' and r.paid_at >= p_from),
    'revenue',         coalesce((select sum(o.charge) from public.orders o where o.status in ('placed', 'checking') and o.created_at >= p_from), 0),
    'provider_cost',   coalesce((select sum(o.cost) from public.orders o where o.status in ('placed', 'checking') and o.created_at >= p_from), 0),
    'orders',          (select count(*) from public.orders o where o.created_at >= p_from),
    'orders_placed',   (select count(*) from public.orders o where o.status = 'placed' and o.created_at >= p_from),
    'orders_refunded', (select count(*) from public.orders o where o.status = 'refunded' and o.created_at >= p_from),
    'refunded_amount', coalesce((select sum(o.charge) from public.orders o where o.status = 'refunded' and o.created_at >= p_from), 0),
    'orders_checking', (select count(*) from public.orders o where o.status = 'checking'),
    'adjustments',     coalesce((select sum(l.delta) from public.ledger l where l.kind = 'adjust' and l.created_at >= p_from), 0),
    'accounts',        (select count(*) from auth.users),
    'new_accounts',    (select count(*) from auth.users u where u.created_at >= p_from),
    'active_customers', (select count(distinct o.user_id) from public.orders o where o.created_at >= p_from),
    'wallet_held',     coalesce((select sum(w.balance) from public.wallets w), 0),
    'open_tickets',    (select count(*) from public.tickets t where t.status = 'open'),
    'unmatched_payments', (select count(*) from public.upi_alerts a where a.recharge_id is null)
  );
$$;

-- One row per day (India time) for the last p_days days.
create function public.admin_daily(p_days integer)
returns table (day date, money_in numeric, revenue numeric, cost numeric, orders bigint)
language sql
stable
security definer
set search_path = public
as $$
  with days as (
    select generate_series((now() at time zone 'Asia/Kolkata')::date - (least(greatest(p_days, 1), 366) - 1),
                           (now() at time zone 'Asia/Kolkata')::date, interval '1 day')::date as day
  ), pay as (
    select (r.paid_at at time zone 'Asia/Kolkata')::date as day, sum(r.credited) as v
    from public.recharges r where r.status = 'paid' and r.paid_at >= now() - make_interval(days => p_days + 1) group by 1
  ), ord as (
    select (o.created_at at time zone 'Asia/Kolkata')::date as day,
           sum(o.charge) filter (where o.status in ('placed', 'checking')) as rev,
           sum(o.cost) filter (where o.status in ('placed', 'checking')) as cost,
           count(*) as n
    from public.orders o where o.created_at >= now() - make_interval(days => p_days + 1) group by 1
  )
  select d.day, coalesce(pay.v, 0), coalesce(ord.rev, 0), coalesce(ord.cost, 0), coalesce(ord.n, 0)
  from days d left join pay on pay.day = d.day left join ord on ord.day = d.day
  order by d.day;
$$;

-- ---------- admin: lists ----------

create function public.admin_users(p_search text, p_limit integer, p_offset integer)
returns table (id uuid, email text, provider text, created_at timestamptz, last_sign_in_at timestamptz,
               balance numeric, added numeric, spent numeric, orders bigint, open_tickets bigint)
language sql
stable
security definer
set search_path = public
as $$
  select u.id, u.email::text, coalesce(u.raw_app_meta_data->>'provider', 'email'), u.created_at, u.last_sign_in_at,
         coalesce(w.balance, 0),
         coalesce((select sum(r.credited) from public.recharges r where r.user_id = u.id and r.status = 'paid'), 0),
         coalesce((select sum(o.charge) from public.orders o where o.user_id = u.id and o.status in ('placed', 'checking')), 0),
         (select count(*) from public.orders o where o.user_id = u.id),
         (select count(*) from public.tickets t where t.user_id = u.id and t.status <> 'closed')
  from auth.users u
  left join public.wallets w on w.user_id = u.id
  where p_search is null or p_search = '' or u.email ilike '%' || p_search || '%' or u.id::text = p_search
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

create function public.admin_orders(p_status text, p_search text, p_limit integer, p_offset integer)
returns table (id bigint, created_at timestamptz, user_id uuid, email text, service_id text, title text, link text,
               quantity integer, charge numeric, cost numeric, status text, smm_order text, error text)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.created_at, o.user_id, u.email::text, o.service_id, o.title, o.link, o.quantity, o.charge, o.cost, o.status, o.smm_order, o.error
  from public.orders o
  left join auth.users u on u.id = o.user_id
  where (p_status is null or p_status = '' or o.status = p_status)
    and (p_search is null or p_search = '' or o.id::text = p_search or o.smm_order = p_search
         or u.email ilike '%' || p_search || '%' or o.link ilike '%' || p_search || '%' or o.title ilike '%' || p_search || '%')
  order by o.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

create function public.admin_payments(p_limit integer, p_offset integer)
returns table (id bigint, created_at timestamptz, paid_at timestamptz, user_id uuid, email text, amount numeric,
               expected_amount numeric, credited numeric, status text, utr text, bank text, payer text, matched_by text, expires_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select r.id, r.created_at, r.paid_at, r.user_id, u.email::text, r.amount, r.expected_amount, r.credited, r.status, r.utr, r.bank, r.payer, r.matched_by, r.expires_at
  from public.recharges r
  left join auth.users u on u.id = r.user_id
  where r.status = 'paid' or r.created_at > now() - interval '2 days'
  order by r.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

-- ---------- admin: actions ----------

-- Add to (positive) or take from (negative) a customer's wallet, with a note in the ledger.
create function public.admin_adjust(p_user uuid, p_delta numeric, p_note text)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  bal numeric;
begin
  if p_delta is null or p_delta = 0 or abs(p_delta) > 100000 then
    raise exception 'BAD_AMOUNT';
  end if;
  insert into public.wallets (user_id, balance) values (p_user, 0) on conflict (user_id) do nothing;
  update public.wallets set balance = balance + p_delta, updated_at = now()
    where user_id = p_user and balance + p_delta >= 0
    returning balance into bal;
  if bal is null then
    raise exception 'BALANCE_NEGATIVE';
  end if;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (p_user, p_delta, bal, 'adjust', left(coalesce(p_note, 'Admin adjustment'), 200));
  return bal;
end;
$$;

-- Refund a placed or "being checked" order to the customer's wallet, once.
create function public.admin_refund_order(p_order bigint, p_note text)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  o public.orders%rowtype;
  bal numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null then raise exception 'ORDER_NOT_FOUND'; end if;
  if o.status = 'refunded' then raise exception 'ALREADY_REFUNDED'; end if;
  if o.status = 'placing' then raise exception 'ORDER_BUSY'; end if;
  insert into public.wallets (user_id, balance) values (o.user_id, 0) on conflict (user_id) do nothing;
  update public.wallets set balance = balance + o.charge, updated_at = now() where user_id = o.user_id returning balance into bal;
  update public.orders set status = 'refunded', error = left(coalesce(p_note, 'Refunded by support'), 200) where id = o.id;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (o.user_id, o.charge, bal, 'refund', o.id::text);
  return bal;
end;
$$;

-- An order held as "being checked" turned out to be on the panel: mark it placed with the panel's order id.
create function public.admin_mark_placed(p_order bigint, p_smm_order text)
returns void
language plpgsql
set search_path = public
as $$
begin
  update public.orders set status = 'placed', smm_order = p_smm_order, error = null where id = p_order and status = 'checking';
  if not found then raise exception 'ORDER_NOT_CHECKING'; end if;
end;
$$;

-- Give an unmatched bank payment (e.g. customer paid without a QR) to a customer: credits what the bank says.
create function public.admin_credit_alert(p_utr text, p_user uuid)
returns numeric
language plpgsql
set search_path = public
as $$
declare
  a public.upi_alerts%rowtype;
  rid bigint;
begin
  select * into a from public.upi_alerts where utr = p_utr for update;
  if a.utr is null then raise exception 'ALERT_NOT_FOUND'; end if;
  if a.recharge_id is not null then raise exception 'ALERT_USED'; end if;
  if a.amount < 1 then raise exception 'AMOUNT_TOO_SMALL'; end if;
  insert into public.recharges (user_id, amount, expected_amount, ref, expires_at, created_at)
    values (p_user, a.amount, a.amount, 'ADM' || a.utr, now(), least(a.received_at, now()))
    returning id into rid;
  return public.credit_upi(rid, a.utr, 'utr');
end;
$$;

-- Only the server may call these.
revoke all on function public.create_ticket(uuid, text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.ticket_post(bigint, uuid, text, text) from public, anon, authenticated;
revoke all on function public.admin_stats(timestamptz) from public, anon, authenticated;
revoke all on function public.admin_daily(integer) from public, anon, authenticated;
revoke all on function public.admin_users(text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_orders(text, text, integer, integer) from public, anon, authenticated;
revoke all on function public.admin_payments(integer, integer) from public, anon, authenticated;
revoke all on function public.admin_adjust(uuid, numeric, text) from public, anon, authenticated;
revoke all on function public.admin_refund_order(bigint, text) from public, anon, authenticated;
revoke all on function public.admin_mark_placed(bigint, text) from public, anon, authenticated;
revoke all on function public.admin_credit_alert(text, uuid) from public, anon, authenticated;
grant execute on function public.create_ticket(uuid, text, text, text, bigint, text) to service_role;
grant execute on function public.ticket_post(bigint, uuid, text, text) to service_role;
grant execute on function public.admin_stats(timestamptz) to service_role;
grant execute on function public.admin_daily(integer) to service_role;
grant execute on function public.admin_users(text, integer, integer) to service_role;
grant execute on function public.admin_orders(text, text, integer, integer) to service_role;
grant execute on function public.admin_payments(integer, integer) to service_role;
grant execute on function public.admin_adjust(uuid, numeric, text) to service_role;
grant execute on function public.admin_refund_order(bigint, text) to service_role;
grant execute on function public.admin_mark_placed(bigint, text) to service_role;
grant execute on function public.admin_credit_alert(text, uuid) to service_role;
