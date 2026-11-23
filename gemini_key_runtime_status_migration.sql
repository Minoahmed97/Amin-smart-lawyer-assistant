-- Runtime status for centrally managed Gemini API keys.
-- Apply this once in the Supabase SQL Editor before deploying the matching app code.

alter table public.app_gemini_keys
  add column if not exists last_status text not null default 'not_tested',
  add column if not exists last_model text null,
  add column if not exists last_error text null,
  add column if not exists last_attempt_at timestamptz null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'app_gemini_keys_last_status_check'
      and conrelid = 'public.app_gemini_keys'::regclass
  ) then
    alter table public.app_gemini_keys
      add constraint app_gemini_keys_last_status_check
      check (last_status in ('not_tested', 'working', 'invalid', 'quota', 'temporary', 'error'));
  end if;
end
$$;
