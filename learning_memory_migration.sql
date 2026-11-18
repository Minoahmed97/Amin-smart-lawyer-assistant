-- Amin Legal Learning Memory
-- Additive migration for the isolated learning module.
-- Requires the existing public.platform_users table.
-- Run manually in Supabase SQL Editor; this file does not alter existing app tables.

begin;

create table if not exists public.amin_learning_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  case_ref text null,
  task_type text not null check (task_type in ('deconstruct', 'qualify', 'draft', 'chat', 'other')),
  event_type text not null default 'correction' check (event_type in ('correction', 'manual_note', 'outcome')),
  status text not null default 'pending_review' check (status in ('pending_review', 'processed', 'ignored')),
  before_text text not null default '',
  after_text text not null default '',
  reason text not null default '',
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz null
);

create index if not exists amin_learning_events_user_status_idx
  on public.amin_learning_events(user_id, status, created_at desc);

create index if not exists amin_learning_events_user_case_idx
  on public.amin_learning_events(user_id, case_ref, created_at desc);

create table if not exists public.amin_professional_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  scope text not null check (scope in ('global', 'case')),
  case_ref text null,
  category text not null check (category in ('decision_rule', 'strategy_rule', 'risk_preference', 'workflow_rule', 'correction_pattern')),
  title text not null,
  content text not null,
  conditions jsonb not null default '{}'::jsonb,
  exceptions jsonb not null default '{}'::jsonb,
  source_event_ids uuid[] not null default '{}'::uuid[],
  confidence numeric(4,3) not null default 0.500 check (confidence >= 0 and confidence <= 1),
  status text not null default 'proposed' check (status in ('proposed', 'approved', 'rejected', 'archived')),
  times_applied integer not null default 0 check (times_applied >= 0),
  last_applied_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reviewed_at timestamptz null,
  constraint amin_professional_memories_scope_ref_check
    check ((scope = 'global' and case_ref is null) or (scope = 'case' and case_ref is not null))
);

create index if not exists amin_professional_memories_user_status_idx
  on public.amin_professional_memories(user_id, status, confidence desc, updated_at desc);

create index if not exists amin_professional_memories_user_case_idx
  on public.amin_professional_memories(user_id, case_ref, status);

create table if not exists public.amin_case_memory (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.platform_users(id) on delete cascade,
  case_ref text not null,
  title text not null default '',
  case_state jsonb not null default '{}'::jsonb,
  source_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, case_ref)
);

create index if not exists amin_case_memory_user_updated_idx
  on public.amin_case_memory(user_id, updated_at desc);

-- These records contain legal work product and private professional corrections.
-- No direct browser access is granted. Access is server-only after the app's
-- signed session is verified and user_id is taken from that verified session.
alter table public.amin_learning_events enable row level security;
alter table public.amin_professional_memories enable row level security;
alter table public.amin_case_memory enable row level security;

revoke all on public.amin_learning_events from anon, authenticated;
revoke all on public.amin_professional_memories from anon, authenticated;
revoke all on public.amin_case_memory from anon, authenticated;

grant all on public.amin_learning_events to service_role;
grant all on public.amin_professional_memories to service_role;
grant all on public.amin_case_memory to service_role;

commit;
