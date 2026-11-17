-- Ameen personal legal-case memory schema.
-- Run this migration in Supabase SQL Editor before enabling the case-memory API.
-- Ownership is tied to platform_users.id (Ameen's signed server session), not auth.uid().

create table if not exists public.legal_cases (
  id uuid primary key default gen_random_uuid(),
  owner_platform_user_id uuid not null references public.platform_users(id) on delete cascade,
  case_number text,
  case_year text,
  court_name text,
  circuit text,
  case_type text,
  client_name text,
  opponent_name text,
  title text not null,
  status text not null default 'active' check (status in ('active','pending','closed','archived')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz
);

create index if not exists legal_cases_owner_updated_idx
  on public.legal_cases(owner_platform_user_id, updated_at desc)
  where archived_at is null;

create table if not exists public.legal_case_records (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.legal_cases(id) on delete cascade,
  owner_platform_user_id uuid not null references public.platform_users(id) on delete cascade,
  record_type text not null check (record_type in (
    'fact','document','memorandum','filing','request','hearing','judgment',
    'analysis','defense','note','task','other'
  )),
  title text not null,
  content text not null default '',
  occurred_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists legal_case_records_case_time_idx
  on public.legal_case_records(case_id, occurred_at desc nulls last, created_at desc);
create index if not exists legal_case_records_owner_idx
  on public.legal_case_records(owner_platform_user_id, case_id);

create table if not exists public.legal_case_documents (
  id uuid primary key default gen_random_uuid(),
  case_id uuid not null references public.legal_cases(id) on delete cascade,
  record_id uuid references public.legal_case_records(id) on delete set null,
  owner_platform_user_id uuid not null references public.platform_users(id) on delete cascade,
  file_name text not null,
  mime_type text not null,
  file_size bigint not null default 0 check (file_size >= 0),
  storage_path text not null unique,
  document_type text not null default 'other',
  extracted_text text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists legal_case_documents_case_idx
  on public.legal_case_documents(case_id, created_at desc);

alter table public.legal_cases enable row level security;
alter table public.legal_cases force row level security;
alter table public.legal_case_records enable row level security;
alter table public.legal_case_records force row level security;
alter table public.legal_case_documents enable row level security;
alter table public.legal_case_documents force row level security;

revoke all on public.legal_cases from anon, authenticated;
revoke all on public.legal_case_records from anon, authenticated;
revoke all on public.legal_case_documents from anon, authenticated;
grant all on public.legal_cases to service_role;
grant all on public.legal_case_records to service_role;
grant all on public.legal_case_documents to service_role;

-- Private bucket; backend service-role access only. No public object URLs.
insert into storage.buckets (id, name, public, file_size_limit)
values ('amin-legal-case-files', 'amin-legal-case-files', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = 52428800;
