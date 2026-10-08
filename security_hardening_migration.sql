-- Ameen Legal Security Hardening migration
-- Run once in Supabase SQL Editor after the existing central schema.
-- Does not change plans, prices, users, or existing data.

create or replace function public.consume_platform_operation(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  u public.platform_users%rowtype;
  trial_expired boolean;
  trial_used_up boolean;
  remaining integer;
begin
  select * into u
  from public.platform_users
  where id = p_user_id
  for update;

  if not found then
    raise exception 'الحساب غير موجود.';
  end if;

  if u.account_status <> 'active' then
    raise exception 'الحساب غير نشط أو موقوف.';
  end if;

  trial_expired := now() >= u.trial_expires_at;
  trial_used_up := u.trial_operations_used >= u.trial_operations_total;

  if not trial_expired and not trial_used_up and u.credits <= 0 then
    u.trial_operations_used := u.trial_operations_used + 1;
    remaining := greatest(0, u.trial_operations_total - u.trial_operations_used);

    update public.platform_users
    set trial_operations_used = u.trial_operations_used,
        operations_used = operations_used + 1,
        last_seen_at = now(),
        account_status = case when remaining = 0 then 'suspended' else 'active' end,
        updated_at = now()
    where id = p_user_id;

    return jsonb_build_object(
      'success', true,
      'remainingCredits', remaining,
      'trialRemaining', remaining
    );
  end if;

  if u.credits <= 0 then
    update public.platform_users
    set account_status = 'suspended', updated_at = now()
    where id = p_user_id;

    raise exception 'انتهت فترة/عمليات التجربة. يرجى شحن الحساب للمتابعة.';
  end if;

  remaining := u.credits - 1;

  update public.platform_users
  set credits = remaining,
      operations_used = operations_used + 1,
      last_seen_at = now(),
      account_status = case when remaining > 0 then 'active' else 'suspended' end,
      updated_at = now()
  where id = p_user_id;

  return jsonb_build_object(
    'success', true,
    'remainingCredits', remaining,
    'trialRemaining', 0
  );
end;
$$;

revoke all on function public.consume_platform_operation(uuid) from public, anon, authenticated;
grant execute on function public.consume_platform_operation(uuid) to service_role;

alter table public.platform_users enable row level security;
alter table public.platform_users add column if not exists deleted_at timestamptz null;
alter table public.platform_users drop constraint if exists platform_users_account_status_check;
alter table public.platform_users add constraint platform_users_account_status_check
  check (account_status in ('active','suspended','deleted'));
create index if not exists platform_users_deleted_idx on public.platform_users(deleted_at);
alter table public.recharge_codes enable row level security;
alter table public.app_gemini_keys enable row level security;
alter table public.platform_packages enable row level security;
alter table public.platform_settings enable row level security;

create table if not exists public.registration_guards (
  id uuid primary key default gen_random_uuid(),
  guard_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists registration_guards_created_idx
  on public.registration_guards(created_at desc);

alter table public.registration_guards enable row level security;

revoke all on public.platform_users from anon, authenticated;
revoke all on public.recharge_codes from anon, authenticated;
revoke all on public.app_gemini_keys from anon, authenticated;
revoke all on public.platform_packages from anon, authenticated;
revoke all on public.platform_settings from anon, authenticated;
revoke all on public.registration_guards from anon, authenticated;
