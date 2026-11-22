-- Persistent, account-scoped legal case files for Amin Smart Lawyer Assistant.
-- Apply this migration once in the Supabase SQL Editor before deploying the API change.

create table if not exists public.legal_case_files (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.platform_users(id) on delete cascade,
  case_id text not null,
  case_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint legal_case_files_owner_case_unique unique (owner_user_id, case_id),
  constraint legal_case_files_case_id_length check (char_length(case_id) between 8 and 120),
  constraint legal_case_files_case_data_object check (jsonb_typeof(case_data) = 'object')
);

create index if not exists legal_case_files_owner_updated_idx
  on public.legal_case_files (owner_user_id, updated_at desc);

alter table public.legal_case_files enable row level security;

-- No anon/authenticated policies are created. All reads and writes go through
-- the authenticated server API using the Supabase server secret/service role.
revoke all on table public.legal_case_files from anon, authenticated;
grant all on table public.legal_case_files to service_role;
