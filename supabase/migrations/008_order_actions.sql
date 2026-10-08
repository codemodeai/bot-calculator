-- Order actions in My orders (run after 007_panel_status.sql):
--   refill  - ask the panel to top up a completed order that dropped (services with refill)
--   cancel  - ask the panel to stop an order that hasn't finished (services with cancel)
-- and the money side: when the panel ends an order as Canceled or Partial, the undelivered share goes back to
-- the customer's wallet once (the panel refunds us the same share).

alter table public.orders add column if not exists refill_id text;
alter table public.orders add column if not exists refill_at timestamptz;
alter table public.orders add column if not exists cancel_requested_at timestamptz;

-- p_status: the panel's status ('canceled' or 'partial'); p_remains: how many it didn't deliver.
-- Returns {refunded, balance}; refunded 0 when there was nothing (more) to give back.
create or replace function public.settle_panel_order(p_order bigint, p_status text, p_remains integer)
returns json
language plpgsql
set search_path = public
as $$
declare
  o public.orders%rowtype;
  frac numeric;
  amt numeric;
  bal numeric;
begin
  select * into o from public.orders where id = p_order for update;
  if o.id is null or o.drip or o.status <> 'placed' or coalesce(o.refunded, 0) > 0 or o.quantity <= 0 then
    return json_build_object('refunded', 0);
  end if;
  if p_status ~* 'cancel' then
    frac := 1;
  elsif p_status ~* 'partial' then
    frac := least(greatest(coalesce(p_remains, 0), 0), o.quantity)::numeric / o.quantity;
  else
    return json_build_object('refunded', 0);
  end if;
  amt := round(o.charge * frac, 4);
  if amt <= 0 then
    return json_build_object('refunded', 0);
  end if;
  update public.orders set
    refunded = amt,
    cost = round(cost * (1 - frac), 4),                         -- the panel only keeps what it delivered
    status = case when frac = 1 then 'refunded' else status end,
    error = case when frac = 1 then 'Canceled on the panel' else 'Partly delivered: ' || coalesce(p_remains, 0) || ' not delivered' end
  where id = o.id;
  insert into public.wallets (user_id, balance) values (o.user_id, 0) on conflict (user_id) do nothing;
  update public.wallets set balance = balance + amt, updated_at = now() where user_id = o.user_id returning balance into bal;
  insert into public.ledger (user_id, delta, balance_after, kind, ref) values (o.user_id, amt, bal, 'refund', o.id::text);
  return json_build_object('refunded', amt, 'balance', bal);
end;
$$;

revoke all on function public.settle_panel_order(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.settle_panel_order(bigint, text, integer) to service_role;
