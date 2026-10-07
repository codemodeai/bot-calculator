-- The panel's own status for each order (completed, in progress, partial, canceled...), saved when the store
-- checks it, so My orders can show it in the list and finished orders aren't asked about again.
-- Run after 006_drip_admin.sql. The store still works without it (it then checks every open order each time).

alter table public.orders add column if not exists panel_status text;
alter table public.orders add column if not exists panel_checked_at timestamptz;
