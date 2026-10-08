-- المستشار أمين — Production Data Migration
-- آمن للبيانات الحالية: لا يحذف جداول أو حسابات أو أرصدة أو أكواد شحن.
-- شغّل هذا الملف مرة واحدة على قاعدة Supabase الحالية.

BEGIN;

-- 1) تثبيت حقول الحذف والحالات الموجودة للحسابات.
ALTER TABLE public.platform_users
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz NULL;

ALTER TABLE public.platform_users
  DROP CONSTRAINT IF EXISTS platform_users_account_status_check;

ALTER TABLE public.platform_users
  ADD CONSTRAINT platform_users_account_status_check
  CHECK (account_status IN ('active', 'suspended', 'deleted'));

CREATE INDEX IF NOT EXISTS platform_users_deleted_idx
  ON public.platform_users(deleted_at);

-- 2) حماية التسجيل الدائمة. لا نحذف منها سجل الجهاز عند حذف الحساب.
CREATE TABLE IF NOT EXISTS public.registration_guards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guard_key text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS registration_guards_created_idx
  ON public.registration_guards(created_at DESC);

ALTER TABLE public.registration_guards ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.registration_guards FROM anon, authenticated;

-- 3) ربط اختياري لكارت الشحن بالباقة التي صدر منها.
-- الأكواد القديمة تظل صالحة لأن package_id يقبل NULL.
ALTER TABLE public.recharge_codes
  ADD COLUMN IF NOT EXISTS package_id text NULL;

CREATE INDEX IF NOT EXISTS recharge_codes_package_idx
  ON public.recharge_codes(package_id);

-- لا نضيف FK إلزاميًا حتى لا نمسّ أكوادًا قديمة إذا حُذفت باقتها لاحقًا.

-- 4) تعديل رصيد الحساب من الخادم في عملية ذرية واحدة.
-- يمنع فقدان شحن متزامن عند تنفيذ عمليتي شحن في نفس اللحظة.
CREATE OR REPLACE FUNCTION public.admin_adjust_platform_balance(
  p_user_id uuid,
  p_amount integer,
  p_mode text DEFAULT 'add'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  u public.platform_users%rowtype;
  new_credits integer;
  trial_remaining integer;
  next_status text;
BEGIN
  IF p_amount < 0 THEN
    RAISE EXCEPTION 'قيمة الرصيد غير صالحة.';
  END IF;

  IF p_mode NOT IN ('add', 'set') THEN
    RAISE EXCEPTION 'طريقة تعديل الرصيد غير صالحة.';
  END IF;

  SELECT * INTO u
  FROM public.platform_users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'الحساب المستهدف غير موجود.';
  END IF;

  new_credits := CASE
    WHEN p_mode = 'set' THEN p_amount
    ELSE u.credits + p_amount
  END;

  trial_remaining := greatest(0, u.trial_operations_total - u.trial_operations_used);
  next_status := CASE
    WHEN new_credits > 0 OR trial_remaining > 0 THEN 'active'
    ELSE 'suspended'
  END;

  UPDATE public.platform_users
  SET credits = new_credits,
      account_status = CASE WHEN account_status = 'deleted' THEN 'deleted' ELSE next_status END,
      updated_at = now()
  WHERE id = p_user_id;

  RETURN jsonb_build_object(
    'newTotal', new_credits,
    'accountStatus', CASE WHEN u.account_status = 'deleted' THEN 'deleted' ELSE next_status END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.admin_adjust_platform_balance(uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_adjust_platform_balance(uuid, integer, text) TO service_role;

-- 5) تأكيد أن جداول الإدارة لا تُقرأ أو تُكتب مباشرة من المتصفح.
ALTER TABLE public.platform_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recharge_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.platform_users FROM anon, authenticated;
REVOKE ALL ON public.recharge_codes FROM anon, authenticated;
REVOKE ALL ON public.platform_packages FROM anon, authenticated;
REVOKE ALL ON public.platform_settings FROM anon, authenticated;

COMMIT;

-- ملاحظة:
-- لا تشغّل SUPABASE_SETUP...RESET-ACCOUNT.sql على قاعدة الإنتاج الحالية،
-- لأنه ملف إعادة إنشاء وقد يحذف البيانات الحالية. استخدم هذا الملف فقط كـ migration.
