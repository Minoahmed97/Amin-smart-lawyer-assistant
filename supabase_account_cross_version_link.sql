-- Cross-deployment account linking for the same browser/device.
-- Run this migration in the CENTRAL Supabase project before deploying the
-- matching Final branch to both the primary and experimental Vercel apps.
alter table public.platform_users
  add column if not exists device_fingerprint_alias text;

create unique index if not exists platform_users_device_fingerprint_alias_uidx
  on public.platform_users(device_fingerprint_alias)
  where device_fingerprint_alias is not null;
