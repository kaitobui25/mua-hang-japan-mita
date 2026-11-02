-- Review-only until the owner authorizes VPS schema changes and a verified backup.
-- PostgreSQL target identity must be checked separately before applying.
-- Only the public API/Admin compatibility delta and title-sync metadata belong on VPS.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SELECT pg_advisory_xact_lock(70400200);

-- Require the existing Owner account; preserve its password and sessions.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.admin_accounts WHERE id=1) THEN
    RAISE EXCEPTION 'Unexpected admin account state: review manually';
  END IF;
END $$;

ALTER TABLE public.admin_accounts DROP CONSTRAINT IF EXISTS admin_accounts_id_check;
ALTER TABLE public.admin_accounts ADD COLUMN IF NOT EXISTS username text;
ALTER TABLE public.admin_accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'owner';
ALTER TABLE public.admin_accounts ADD COLUMN IF NOT EXISTS enabled boolean NOT NULL DEFAULT true;
UPDATE public.admin_accounts SET username='owner',role='owner'
  WHERE id=1 AND (username IS DISTINCT FROM 'owner' OR role IS DISTINCT FROM 'owner');
ALTER TABLE public.admin_accounts ALTER COLUMN username SET DEFAULT 'owner';
ALTER TABLE public.admin_accounts ALTER COLUMN username SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS admin_accounts_username_idx ON public.admin_accounts(username);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.admin_accounts'::regclass
      AND conname='admin_accounts_roles_valid') THEN
    ALTER TABLE public.admin_accounts ADD CONSTRAINT admin_accounts_roles_valid CHECK (
      (id=1 AND role='owner' AND username='owner')
      OR (id>1 AND role='staff' AND username ~ '^[a-z][a-z0-9_-]{2,31}$')
    );
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS public.admin_staff_login_limit (
  username text PRIMARY KEY REFERENCES public.admin_accounts(username) ON DELETE CASCADE,
  attempts integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now()
);

-- The Windows PC creates revision history; the VPS only receives metadata and titles.
ALTER TABLE public.product_translations ADD COLUMN IF NOT EXISTS name_revision bigint;
ALTER TABLE public.product_translations ADD COLUMN IF NOT EXISTS name_generation uuid;
ALTER TABLE public.product_translations ADD COLUMN IF NOT EXISTS name_model text;
COMMIT;
