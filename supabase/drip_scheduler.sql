-- Gradual delivery scheduler: Supabase calls your store's /api/drip every 5 minutes, which sends the parts that are due.
-- Run once in Supabase -> SQL Editor, AFTER the code with api/drip.js is live on Vercel.
-- Before running, replace the two placeholders:
--   YOUR-STORE.vercel.app  -> your live store address (no https://, no trailing slash)
--   YOUR-CRON-SECRET       -> the same long random value you put in Vercel as CRON_SECRET
-- (Vercel's free plan only runs its own cron jobs once a day, so the database does the timing instead.)

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- The secret lives in Supabase Vault, not in the job text.
select vault.create_secret('YOUR-CRON-SECRET', 'boostly_cron_secret', 'Bearer token for /api/drip');

select cron.schedule('boostly-drip', '*/5 * * * *', $job$
  select net.http_post(
    url := 'https://YOUR-STORE.vercel.app/api/drip',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'boostly_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$job$);

-- Check it's working (a few minutes later):
--   select status_code, content, created from net._http_response order by created desc limit 5;
--   -> 200 with {"ok":true,...}. 401 means the secret differs from Vercel's CRON_SECRET.
-- Change the address later:  select cron.alter_job((select jobid from cron.job where jobname = 'boostly-drip'), command := $$ ... $$);
-- Stop it:                   select cron.unschedule('boostly-drip');
