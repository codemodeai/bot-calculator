-- Admin orders list knows about gradual orders (run after 005_drip.sql).
--   status 'checking' also finds gradual orders with a part waiting to be checked
--   status 'drip' lists gradual orders
--   searching a panel order number also finds the gradual order it belongs to
--   admin_part gets 'refund': a part being checked never reached the panel, so its share goes back to the wallet
-- Same arguments and columns as before, so this only replaces the function body.

create or replace function public.admin_orders(p_status text, p_search text, p_limit integer, p_offset integer)
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
  where (p_status is null or p_status = ''
         or (p_status = 'drip' and o.drip)
         or (p_status = 'checking' and (o.status = 'checking'
             or exists (select 1 from public.order_parts p where p.order_id = o.id and p.status = 'checking')))
         or (p_status not in ('drip', 'checking') and o.status = p_status))
    and (p_search is null or p_search = '' or o.id::text = p_search or o.smm_order = p_search
         or exists (select 1 from public.order_parts p where p.order_id = o.id and p.smm_order = p_search)
         or u.email ilike '%' || p_search || '%' or o.link ilike '%' || p_search || '%' or o.title ilike '%' || p_search || '%')
  order by o.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.admin_orders(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.admin_orders(text, text, integer, integer) to service_role;

-- Support: a part marked 'checking' did reach the panel (placed), didn't and should be sent now (retry, only while
-- the order runs), or didn't and should be refunded (refund).
create or replace function public.admin_part(p_part bigint, p_action text, p_smm_order text)
returns void
language plpgsql
set search_path = public
as $$
declare
  p public.order_parts%rowtype;
  uid uuid;
  bal numeric;
begin
  select * into p from public.order_parts where id = p_part for update;
  if p.id is null then raise exception 'PART_NOT_FOUND'; end if;
  if p_action = 'placed' and p.status = 'checking' then
    perform public.finish_part(p.id, p_smm_order);
  elsif p_action = 'retry' and p.status = 'checking' and exists (select 1 from public.orders o where o.id = p.order_id and o.drip_state = 'running') then
    -- only when it's certain the part is NOT on the panel; failed parts were already refunded and are never resent
    update public.order_parts set status = 'scheduled', scheduled_at = now(), attempts = 0, error = null, updated_at = now() where id = p.id;
  elsif p_action = 'refund' and p.status = 'checking' then
    update public.order_parts set status = 'canceled', error = 'Not on the panel: refunded by support', updated_at = now() where id = p.id;
    update public.orders set refunded = refunded + p.charge where id = p.order_id returning user_id into uid;
    insert into public.wallets (user_id, balance) values (uid, 0) on conflict (user_id) do nothing;
    update public.wallets set balance = balance + p.charge, updated_at = now() where user_id = uid returning balance into bal;
    insert into public.ledger (user_id, delta, balance_after, kind, ref) values (uid, p.charge, bal, 'refund', p.order_id::text);
    if not exists (select 1 from public.order_parts where order_id = p.order_id and status in ('scheduled', 'placing', 'checking')) then
      update public.orders set drip_state = 'done' where id = p.order_id and drip_state = 'running';
    end if;
  else
    raise exception 'PART_NOT_ALLOWED';
  end if;
end;
$$;

revoke all on function public.admin_part(bigint, text, text) from public, anon, authenticated;
grant execute on function public.admin_part(bigint, text, text) to service_role;
