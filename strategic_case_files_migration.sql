-- Strategic Legal Assistant: isolated, account-owned case files.
-- Apply this migration in the central Supabase project before enabling the API.
create table if not exists public.app_strategic_case_files (
  case_id uuid not null,
  owner_user_id uuid not null,
  case_data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint app_strategic_case_files_pkey primary key (case_id),
  constraint app_strategic_case_files_owner_case_unique unique (owner_user_id, case_id),
  constraint app_strategic_case_files_data_object check (jsonb_typeof(case_data) = 'object')
);

create index if not exists app_strategic_case_files_owner_updated_idx
  on public.app_strategic_case_files (owner_user_id, updated_at desc);

alter table public.app_strategic_case_files enable row level security;

-- No browser-facing policies are created. All access is through the authenticated
-- central API, which verifies the signed platform session and scopes every query
-- to its user_id before using the server-only Supabase credential.
