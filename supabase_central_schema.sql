-- Central platform schema for "المستشار أمين"
-- Run once in Supabase SQL Editor before deploying the new account/recharge features.
-- The backend uses SUPABASE_SERVICE_ROLE_KEY and never exposes it to the browser.

create extension if not exists pgcrypto;

create table if not exists public.platform_users (
  id uuid primary key default gen_random_uuid(),
  username text not null unique,
  display_name text not null,
  password_hash text not null,
  device_fingerprint text not null unique,
  role text not null default 'lawyer' check (role = 'lawyer'),
  credits integer not null default 0 check (credits >= 0),
  trial_operations_total integer not null default 20,
  trial_operations_used integer not null default 0,
  trial_started_at timestamptz not null default now(),
  trial_expires_at timestamptz not null,
  account_status text not null default 'active' check (account_status in ('active','suspended','deleted')),
  deleted_at timestamptz null,
  operations_used integer not null default 0,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.platform_users add column if not exists operations_used integer not null default 0;
alter table public.platform_users add column if not exists last_seen_at timestamptz not null default now();
alter table public.platform_users add column if not exists deleted_at timestamptz null;
alter table public.platform_users drop constraint if exists platform_users_account_status_check;
alter table public.platform_users add constraint platform_users_account_status_check
  check (account_status in ('active','suspended','deleted'));

create index if not exists platform_users_status_idx on public.platform_users(account_status);
create index if not exists platform_users_created_idx on public.platform_users(created_at desc);
create index if not exists platform_users_deleted_idx on public.platform_users(deleted_at);

-- Persistent registration guard used to prevent repeated free-trial claims
-- from the same browser/device signature.
create table if not exists public.registration_guards (
  id uuid primary key default gen_random_uuid(),
  guard_key text not null unique,
  created_at timestamptz not null default now()
);

create index if not exists registration_guards_created_idx
  on public.registration_guards(created_at desc);

create table if not exists public.recharge_codes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  credits integer not null check (credits > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz null,
  redeemed_by uuid null references public.platform_users(id) on delete set null
);

create index if not exists recharge_codes_unused_idx
  on public.recharge_codes(active, redeemed_at)
  where redeemed_at is null;

create table if not exists public.app_gemini_keys (
  id uuid primary key default gen_random_uuid(),
  api_key text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);


create table if not exists public.app_broadcast_announcements (
  id text primary key,
  is_active boolean not null default true,
  title text not null,
  message text not null,
  type text not null default 'info',
  action_text text,
  action_url text,
  updated_at timestamptz not null default now()
);
alter table public.app_broadcast_announcements enable row level security;
revoke all on public.app_broadcast_announcements from anon, authenticated;

-- Packages are persisted centrally instead of only in server memory.
create table if not exists public.platform_packages (
  id text primary key,
  name text not null,
  credits integer not null check (credits > 0),
  price text not null,
  numeric_price numeric not null default 0,
  badge text,
  popular boolean not null default false,
  description text not null default '',
  features jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Server-side central settings used by platform administration.
create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.platform_users enable row level security;
alter table public.recharge_codes enable row level security;
alter table public.app_gemini_keys enable row level security;
alter table public.platform_packages enable row level security;
alter table public.platform_settings enable row level security;
alter table public.registration_guards enable row level security;

-- No public/client role is granted direct access. The server's service role bypasses RLS.
revoke all on public.platform_users from anon, authenticated;
revoke all on public.recharge_codes from anon, authenticated;
revoke all on public.app_gemini_keys from anon, authenticated;
revoke all on public.platform_packages from anon, authenticated;
revoke all on public.platform_settings from anon, authenticated;
revoke all on public.registration_guards from anon, authenticated;

-- Initial package prices: 15 EGP per judicial operation.
insert into public.platform_packages
(id,name,credits,price,numeric_price,badge,popular,description,features,enabled)
values
('pkg_15','باقة 15 عملية قضائية',15,'225 جنيه',225,'أساسية',false,'15 عملية قضائية — 15 جنيه للعملية الواحدة.',
 '["15 عملية قضائية","رفع وتحليل المستندات","البث المباشر للإجابة"]'::jsonb,true),
('pkg_30','باقة 30 عملية قضائية',30,'450 جنيه',450,'الأكثر طلباً',true,'30 عملية قضائية — 15 جنيه للعملية الواحدة.',
 '["30 عملية قضائية","رفع وتحليل المستندات","البث المباشر للإجابة"]'::jsonb,true),
('pkg_60','باقة 60 عملية قضائية',60,'900 جنيه',900,'مكاتب',false,'60 عملية قضائية — 15 جنيه للعملية الواحدة.',
 '["60 عملية قضائية","رفع وتحليل المستندات","البث المباشر للإجابة"]'::jsonb,true)
on conflict (id) do update set
  credits=excluded.credits,
  price=excluded.price,
  numeric_price=excluded.numeric_price,
  description=excluded.description,
  features=excluded.features,
  updated_at=now();


create or replace function public.consume_platform_operation(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare u public.platform_users%rowtype;
declare trial_expired boolean;
declare trial_used_up boolean;
declare remaining integer;
begin
  select * into u from public.platform_users where id = p_user_id for update;
  if not found then raise exception 'الحساب غير موجود.'; end if;

  if u.account_status <> 'active' then
    raise exception 'الحساب غير نشط أو موقوف.';
  end if;

  trial_expired := now() >= u.trial_expires_at;
  trial_used_up := u.trial_operations_used >= u.trial_operations_total;

  if not trial_expired and not trial_used_up and u.credits <= 0 then
    u.trial_operations_used := u.trial_operations_used + 1;
    remaining := greatest(0, u.trial_operations_total - u.trial_operations_used);
    update public.platform_users
      set trial_operations_used=u.trial_operations_used,
          operations_used=operations_used+1,
          last_seen_at=now(),
          account_status=case when remaining=0 then 'suspended' else 'active' end,
          updated_at=now()
      where id=p_user_id;
    return jsonb_build_object('success',true,'remainingCredits',remaining,'trialRemaining',remaining);
  end if;

  if u.credits <= 0 then
    update public.platform_users set account_status='suspended', updated_at=now() where id=p_user_id;
    raise exception 'انتهت فترة/عمليات التجربة. يرجى شحن الحساب للمتابعة.';
  end if;

  remaining := u.credits - 1;
  update public.platform_users
    set credits=remaining, operations_used=operations_used+1, last_seen_at=now(), account_status=case when remaining>0 then 'active' else 'suspended' end, updated_at=now()
    where id=p_user_id;
  return jsonb_build_object('success',true,'remainingCredits',remaining,'trialRemaining',0);
end;
$$;

create or replace function public.redeem_recharge_code(p_user_id uuid, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare c public.recharge_codes%rowtype;
declare new_balance integer;
begin
  select * into c
    from public.recharge_codes
    where code=upper(trim(p_code)) and active=true and redeemed_at is null
    for update;
  if not found then raise exception 'كود الشحن غير صحيح أو مستخدم من قبل.'; end if;

  update public.recharge_codes
    set redeemed_at=now(), redeemed_by=p_user_id
    where id=c.id;

  update public.platform_users
    set credits=credits+c.credits, account_status='active', updated_at=now()
    where id=p_user_id
    returning credits into new_balance;

  if not found then raise exception 'الحساب غير موجود.'; end if;
  return jsonb_build_object('newTotal',new_balance,'added',c.credits);
end;
$$;

revoke all on function public.consume_platform_operation(uuid) from public, anon, authenticated;
revoke all on function public.redeem_recharge_code(uuid,text) from public, anon, authenticated;
grant execute on function public.consume_platform_operation(uuid) to service_role;
grant execute on function public.redeem_recharge_code(uuid,text) to service_role;


-- Security hardening: deny direct client access to all platform tables/functions.
revoke all on public.platform_users from anon, authenticated;
revoke all on public.recharge_codes from anon, authenticated;
revoke all on public.app_gemini_keys from anon, authenticated;
revoke all on public.platform_packages from anon, authenticated;
revoke all on public.platform_settings from anon, authenticated;
