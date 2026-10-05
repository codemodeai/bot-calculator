-- Gradual delivery: one customer order is split into parts that are sent to the panel one after another.
--
-- The customer pays the whole price (+20%) up front. Each part has its own share of the price, the panel cost,
-- a scheduled time and a panel order number. A part is only sent once the one before it has been placed
-- (the server also waits for the panel to finish it). If a part keeps failing, or the customer cancels, the
-- parts not yet sent are refunded to the wallet. The parent order keeps status 'placed'; drip_state says
-- where the parts are: running, done (all sent), canceled (by the customer/support) or stopped (failed).

alter table public.orders
  add column drip             boolean not null default false,
  add column drip_state       text check (drip_state in ('running', 'done', 'canceled', 'stopped')),
  add column parts            integer,
  add column interval_minutes integer,
  add column refunded         numeric(14, 4) not null default 0;

create table public.order_parts (
  id           bigint generated always as identity primary key,
  order_id     bigint not null references public.orders (id) on delete cascade,
  seq          integer not null,
  quantity     integer not null check (quantity > 0),
  charge       numeric(14, 4) not null check (charge >= 0),   -- this part's share of what the customer paid
  cost         numeric(14, 4),                                -- panel price for this part
  status       text not null default 'scheduled'
               check (status in ('scheduled', 'placing', 'placed', 'checking', 'failed', 'canceled')),
  smm_order    text,
  scheduled_at timestamptz not null,
  placed_at    timestamptz,
  attempts     integer not null default 0,
  error        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (order_id, seq)
);
create index order_parts_due_idx on public.order_parts (scheduled_at) where status = 'scheduled';
alter table public.order_parts enable row level security;

-- Take the whole price from the wallet and record the order with its parts (p_parts: [{quantity, charge, cost, at}]).
create function public.place_drip_order(p_user uuid, p_service_id text, p_title text, p_link text, p_quantity integer,
                                        p_charge numeric, p_cost numeric, p_interval integer, p_parts jsonb)
returns table (order_id bigint, balance numeric)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
declare
  bal numeric;
  oid bigint;
  n integer := jsonb_array_length(coalesce(p_parts, '[]'::jsonb));
begin
  if p_charge is null or p_charge <= 0 or n < 2 or n > 30 then
    raise exception 'BAD_ORDER';
  end if;
  if (select sum((e->>'quantity')::integer) from jsonb_array_elements(p_parts) e) <> p_quantity
     or abs((select sum((e->>'charge')::numeric) from jsonb_array_elements(p_parts) e) - p_charge) > 0.0001 then
    raise exception 'BAD_PARTS';
  end if;
  update public.wallets w set balance = w.balance - p_charge, updated_at = now()
    where w.user_id = p_user and w.balance >= p_charge
    returning w.balance into bal;
  if not found then
    raise exception 'INSUFFICIENT_FUNDS';
  end if;
  insert into public.orders (user_id, service_id, title, link, quantity, charge, cost, status, drip, drip_state, parts, interval_minutes)
    values (p_user, p_service_id, p_title, p_link, p_quantity, p_charge, p_cost, 'placed', true, 'running', n, p_interval)
    returning id into oid;
  insert into public.order_parts (order_id, seq, quantity, charge, cost, scheduled_at)
    select oid, (x.ord)::integer, (x.e->>'quantity')::integer, (x.e->>'charge')::numeric, (x.e->>'cost')::numeric, (x.e->>'at')::timestamptz
    from jsonb_array_elements(p_parts) with ordinality as x(e, ord);
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (p_user, -p_charge, bal, 'order', oid::text);
  return query select oid, bal;
end;
$$;

-- Hand out parts that are due (to one worker each), oldest first. A part is due when its time has come, its order
-- is running, and the part before it has been placed. Parts stuck in 'placing' for 10+ minutes go to 'checking'.
create function public.claim_due_parts(p_limit integer, p_order bigint)
returns table (part_id bigint, order_id bigint, seq integer, quantity integer, attempts integer,
               service_id text, link text, prev_smm text)
language plpgsql
set search_path = public
as $$
#variable_conflict use_column
begin
  update public.order_parts set status = 'checking', error = 'Interrupted while sending to the panel', updated_at = now()
    where status = 'placing' and updated_at < now() - interval '10 minutes';
  return query
  with due as (
    select p.id from public.order_parts p
    join public.orders o on o.id = p.order_id
    where p.status = 'scheduled' and p.scheduled_at <= now() and o.drip_state = 'running'
      and (p_order is null or p.order_id = p_order)
      and (p.seq = 1 or exists (select 1 from public.order_parts q where q.order_id = p.order_id and q.seq = p.seq - 1 and q.status = 'placed'))
    order by p.scheduled_at
    limit least(greatest(coalesce(p_limit, 10), 1), 50)
    for update of p skip locked
  ), upd as (
    update public.order_parts p set status = 'placing', attempts = p.attempts + 1, updated_at = now()
    from due where p.id = due.id
    returning p.id, p.order_id, p.seq, p.quantity, p.attempts
  )
  select u.id, u.order_id, u.seq, u.quantity, u.attempts, o.service_id, o.link,
         (select q.smm_order from public.order_parts q where q.order_id = u.order_id and q.seq = u.seq - 1)
  from upd u join public.orders o on o.id = u.order_id;
end;
$$;

-- The panel accepted a part. When no part is left to send, the order's parts are done.
create function public.finish_part(p_part bigint, p_smm_order text)
returns void
language plpgsql
set search_path = public
as $$
declare
  oid bigint;
begin
  update public.order_parts set status = 'placed', smm_order = p_smm_order, placed_at = now(), error = null, updated_at = now()
    where id = p_part and status in ('placing', 'checking')
    returning order_id into oid;
  if oid is not null and not exists (select 1 from public.order_parts where order_id = oid and status in ('scheduled', 'placing', 'checking')) then
    update public.orders set drip_state = 'done' where id = oid and drip_state = 'running';
  end if;
end;
$$;

-- Not yet: try again in p_minutes (e.g. the previous part is still delivering). p_undo_attempt: don't count this try.
create function public.postpone_part(p_part bigint, p_minutes integer, p_note text, p_undo_attempt boolean)
returns void
language sql
set search_path = public
as $$
  update public.order_parts set status = 'scheduled', scheduled_at = now() + make_interval(mins => greatest(p_minutes, 1)),
    error = left(p_note, 200), attempts = case when p_undo_attempt then greatest(attempts - 1, 0) else attempts end, updated_at = now()
  where id = p_part and status = 'placing';
$$;

-- Refund every part of an order that hasn't been sent (scheduled), mark them canceled, and set the order's state.
create function public.refund_unsent_parts(p_order bigint, p_state text, p_note text)
returns json
language plpgsql
set search_path = public
as $$
declare
  o public.orders%rowtype;
  amt numeric;
  bal numeric;
begin
  select * into o from public.orders where id = p_order for update;
  update public.order_parts set status = 'canceled', updated_at = now(), error = coalesce(error, left(p_note, 200))
    where order_id = p_order and status = 'scheduled';
  select coalesce(sum(charge), 0) into amt from public.order_parts where order_id = p_order and status in ('canceled', 'failed');
  amt := amt - o.refunded;                                     -- only what hasn't been refunded already
  update public.orders set drip_state = p_state, refunded = refunded + greatest(amt, 0), error = coalesce(left(p_note, 200), error) where id = p_order;
  if amt > 0 then
    insert into public.wallets (user_id, balance) values (o.user_id, 0) on conflict (user_id) do nothing;
    update public.wallets set balance = balance + amt, updated_at = now() where user_id = o.user_id returning balance into bal;
    insert into public.ledger (user_id, delta, balance_after, kind, ref) values (o.user_id, amt, bal, 'refund', p_order::text);
  else
    select balance into bal from public.wallets where user_id = o.user_id;
  end if;
  return json_build_object('refunded', greatest(amt, 0), 'balance', coalesce(bal, 0));
end;
$$;

-- The panel refused a part. Up to 3 tries (15 minutes apart); after that the order stops and unsent parts are refunded.
create function public.fail_part(p_part bigint, p_error text)
returns json
language plpgsql
set search_path = public
as $$
declare
  p public.order_parts%rowtype;
begin
  select * into p from public.order_parts where id = p_part for update;
  if p.id is null or p.status <> 'placing' then
    return json_build_object('stopped', false);
  end if;
  if p.attempts < 3 then
    update public.order_parts set status = 'scheduled', scheduled_at = now() + interval '15 minutes', error = left(p_error, 200), updated_at = now() where id = p.id;
    return json_build_object('stopped', false, 'retry', true);
  end if;
  update public.order_parts set status = 'failed', error = left(p_error, 200), updated_at = now() where id = p.id;
  return (jsonb_build_object('stopped', true) || public.refund_unsent_parts(p.order_id, 'stopped', 'Stopped: ' || p_error)::jsonb)::json;
end;
$$;

-- The panel didn't answer: the part may or may not be on the panel, so it waits for someone to check.
create function public.check_part(p_part bigint, p_note text)
returns void
language sql
set search_path = public
as $$
  update public.order_parts set status = 'checking', error = left(p_note, 200), updated_at = now() where id = p_part and status = 'placing';
$$;

-- Customer (p_user) or support (p_user null) cancels the rest of a running gradual order.
create function public.cancel_drip(p_order bigint, p_user uuid)
returns json
language plpgsql
set search_path = public
as $$
declare
  o public.orders%rowtype;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or not o.drip or (p_user is not null and o.user_id <> p_user) then
    raise exception 'ORDER_NOT_FOUND';
  end if;
  if o.drip_state <> 'running' then
    raise exception 'NOT_RUNNING';
  end if;
  return public.refund_unsent_parts(o.id, 'canceled', case when p_user is null then 'Canceled by support' else 'Canceled by customer' end);
end;
$$;

-- Support: a part marked 'checking' did reach the panel (mark placed), or didn't and should be sent again (retry now).
create function public.admin_part(p_part bigint, p_action text, p_smm_order text)
returns void
language plpgsql
set search_path = public
as $$
declare
  p public.order_parts%rowtype;
begin
  select * into p from public.order_parts where id = p_part for update;
  if p.id is null then raise exception 'PART_NOT_FOUND'; end if;
  if p_action = 'placed' and p.status = 'checking' then
    perform public.finish_part(p.id, p_smm_order);
  elsif p_action = 'retry' and p.status = 'checking' and exists (select 1 from public.orders o where o.id = p.order_id and o.drip_state = 'running') then
    -- only when it's certain the part is NOT on the panel; failed parts were already refunded and are never resent
    update public.order_parts set status = 'scheduled', scheduled_at = now(), attempts = 0, error = null, updated_at = now() where id = p.id;
  else
    raise exception 'PART_NOT_ALLOWED';
  end if;
end;
$$;

-- ---------- admin numbers now count gradual orders correctly ----------
-- Revenue = what customers paid minus refunds; provider cost of a gradual order = cost of the parts actually sent.

create or replace function public.admin_stats(p_from timestamptz)
returns json
language sql
stable
security definer
set search_path = public
as $$
  with live as (
    select o.*, case when o.drip then coalesce((select sum(p.cost) from public.order_parts p where p.order_id = o.id and p.status in ('placed', 'placing', 'checking')), 0) else o.cost end as real_cost
    from public.orders o where o.status in ('placed', 'checking') and o.created_at >= p_from
  )
  select json_build_object(
    'money_in',        coalesce((select sum(r.credited) from public.recharges r where r.status = 'paid' and r.paid_at >= p_from), 0),
    'payments',        (select count(*) from public.recharges r where r.status = 'paid' and r.paid_at >= p_from),
    'revenue',         coalesce((select sum(l.charge - l.refunded) from live l), 0),
    'provider_cost',   coalesce((select sum(l.real_cost) from live l), 0),
    'orders',          (select count(*) from public.orders o where o.created_at >= p_from),
    'orders_placed',   (select count(*) from public.orders o where o.status = 'placed' and o.created_at >= p_from),
    'orders_refunded', (select count(*) from public.orders o where (o.status = 'refunded' or o.refunded > 0) and o.created_at >= p_from),
    'refunded_amount', coalesce((select sum(case when o.status = 'refunded' then o.charge else o.refunded end) from public.orders o where o.created_at >= p_from), 0),
    'orders_checking', (select count(*) from public.orders o where o.status = 'checking')
                       + (select count(distinct p.order_id) from public.order_parts p where p.status = 'checking'),
    'drip_running',    (select count(*) from public.orders o where o.drip_state = 'running'),
    'adjustments',     coalesce((select sum(l.delta) from public.ledger l where l.kind = 'adjust' and l.created_at >= p_from), 0),
    'accounts',        (select count(*) from auth.users),
    'new_accounts',    (select count(*) from auth.users u where u.created_at >= p_from),
    'active_customers', (select count(distinct o.user_id) from public.orders o where o.created_at >= p_from),
    'wallet_held',     coalesce((select sum(w.balance) from public.wallets w), 0),
    'open_tickets',    (select count(*) from public.tickets t where t.status = 'open'),
    'unmatched_payments', (select count(*) from public.upi_alerts a where a.recharge_id is null)
  );
$$;

create or replace function public.admin_daily(p_days integer)
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
           sum(o.charge - o.refunded) filter (where o.status in ('placed', 'checking')) as rev,
           sum(case when o.drip then coalesce((select sum(p.cost) from public.order_parts p where p.order_id = o.id and p.status in ('placed', 'placing', 'checking')), 0) else o.cost end)
             filter (where o.status in ('placed', 'checking')) as cost,
           count(*) as n
    from public.orders o where o.created_at >= now() - make_interval(days => p_days + 1) group by 1
  )
  select d.day, coalesce(pay.v, 0), coalesce(ord.rev, 0), coalesce(ord.cost, 0), coalesce(ord.n, 0)
  from days d left join pay on pay.day = d.day left join ord on ord.day = d.day
  order by d.day;
$$;

create or replace function public.admin_users(p_search text, p_limit integer, p_offset integer)
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
         coalesce((select sum(o.charge - o.refunded) from public.orders o where o.user_id = u.id and o.status in ('placed', 'checking')), 0),
         (select count(*) from public.orders o where o.user_id = u.id),
         (select count(*) from public.tickets t where t.user_id = u.id and t.status <> 'closed')
  from auth.users u
  left join public.wallets w on w.user_id = u.id
  where p_search is null or p_search = '' or u.email ilike '%' || p_search || '%' or u.id::text = p_search
  order by u.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

-- A gradual order is refunded part by part (cancel_drip), never all at once.
create or replace function public.admin_refund_order(p_order bigint, p_note text)
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
  if o.drip then raise exception 'DRIP_ORDER'; end if;
  if o.status = 'refunded' then raise exception 'ALREADY_REFUNDED'; end if;
  if o.status = 'placing' then raise exception 'ORDER_BUSY'; end if;
  insert into public.wallets (user_id, balance) values (o.user_id, 0) on conflict (user_id) do nothing;
  update public.wallets set balance = balance + o.charge, updated_at = now() where user_id = o.user_id returning balance into bal;
  update public.orders set status = 'refunded', error = left(coalesce(p_note, 'Refunded by support'), 200) where id = o.id;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (o.user_id, o.charge, bal, 'refund', o.id::text);
  return bal;
end;
$$;

-- Only the server may call these.
revoke all on function public.place_drip_order(uuid, text, text, text, integer, numeric, numeric, integer, jsonb) from public, anon, authenticated;
revoke all on function public.claim_due_parts(integer, bigint) from public, anon, authenticated;
revoke all on function public.finish_part(bigint, text) from public, anon, authenticated;
revoke all on function public.postpone_part(bigint, integer, text, boolean) from public, anon, authenticated;
revoke all on function public.refund_unsent_parts(bigint, text, text) from public, anon, authenticated;
revoke all on function public.fail_part(bigint, text) from public, anon, authenticated;
revoke all on function public.check_part(bigint, text) from public, anon, authenticated;
revoke all on function public.cancel_drip(bigint, uuid) from public, anon, authenticated;
revoke all on function public.admin_part(bigint, text, text) from public, anon, authenticated;
grant execute on function public.place_drip_order(uuid, text, text, text, integer, numeric, numeric, integer, jsonb) to service_role;
grant execute on function public.claim_due_parts(integer, bigint) to service_role;
grant execute on function public.finish_part(bigint, text) to service_role;
grant execute on function public.postpone_part(bigint, integer, text, boolean) to service_role;
grant execute on function public.refund_unsent_parts(bigint, text, text) to service_role;
grant execute on function public.fail_part(bigint, text) to service_role;
grant execute on function public.check_part(bigint, text) to service_role;
grant execute on function public.cancel_drip(bigint, uuid) to service_role;
grant execute on function public.admin_part(bigint, text, text) to service_role;
