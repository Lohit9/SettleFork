-- ============================================================
-- 080: SSO provider cert metadata columns
--
-- Add cert metadata columns to public.sso_providers for the org-admin-
-- driven SAML provider configuration flow (B-2-c-iii). Columns are
-- populated when an admin uploads / pastes IdP metadata via the
-- self-serve flow shipped in commits 2 and 3 of this epic. They power:
--   - B-2-c-iii: display cert details on the admin SSO settings page
--   - B-2-c-iv: test-connection diagnostics ("does the IdP signing cert
--               we have on file match the one in the live response?")
--   - B-2-c-v:  cert-rotation detection (compare new fingerprint to the
--               stored one when an admin re-uploads metadata)
--
-- Migration is purely additive. All columns are nullable so existing
-- sso_providers rows (configured via the platform-admin path before
-- B-2-c-iii) remain valid with NULL cert metadata until the org
-- re-uploads metadata through the new flow.
--
-- Numbering note: the original B-2-c-iii investigation expected this
-- to be migration 071, but 071_sso_enforcement.sql, 072..078 were
-- merged in the meantime. Initially renumbered to 079, then bumped
-- again to 080 because feat/project-rbac claimed 079 first
-- (079_project_rbac_strict_membership.sql in the settle-platform
-- worktree, committed before this branch). No semantic change.
--
-- Dependencies (must be applied first):
--   070  public.sso_providers table created
--
-- Additive-only guarantee:
--   * No DROP TABLE / DROP COLUMN / DROP INDEX.
--   * No UPDATE / DELETE on existing rows.
--   * All ALTER TABLE clauses use IF NOT EXISTS so the migration is
--     idempotent under replay.
--
-- Rollback strategy:
--   A future migration can DROP COLUMN ... CASCADE on the five new
--   columns and DROP INDEX on idx_sso_providers_cert_fingerprint.
--   No customer data is at risk because all values are populated
--   server-side from IdP metadata that the admin can re-supply.
-- ============================================================

ALTER TABLE public.sso_providers
  ADD COLUMN IF NOT EXISTS cert_fingerprint_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS cert_subject TEXT,
  ADD COLUMN IF NOT EXISTS cert_not_before TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cert_not_after TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cert_signature_algorithm TEXT;

-- Partial index for cert-rotation detection queries (B-2-c-v).
-- Partial because the column is nullable for legacy rows and we never
-- need to look up NULL fingerprints.
CREATE INDEX IF NOT EXISTS idx_sso_providers_cert_fingerprint
  ON public.sso_providers (cert_fingerprint_sha256)
  WHERE cert_fingerprint_sha256 IS NOT NULL;

COMMENT ON COLUMN public.sso_providers.cert_fingerprint_sha256 IS
  'SHA-256 fingerprint of the IdP signing certificate, lowercase hex no colons. Populated by the org-admin metadata upload flow (B-2-c-iii). NULL for providers configured via the platform-admin path before B-2-c-iii landed.';

COMMENT ON COLUMN public.sso_providers.cert_subject IS
  'X.509 Subject DN of the IdP signing certificate. Diagnostic display only; not used for any security decision.';

COMMENT ON COLUMN public.sso_providers.cert_not_before IS
  'Certificate validity start timestamp (X.509 notBefore field). Sourced from the cert during metadata upload; never edited.';

COMMENT ON COLUMN public.sso_providers.cert_not_after IS
  'Certificate validity end timestamp (X.509 notAfter field). Used by the admin UI to surface expiry warnings.';

COMMENT ON COLUMN public.sso_providers.cert_signature_algorithm IS
  'Human-readable signature algorithm (e.g. sha256WithRSAEncryption). Used to surface deprecated-algorithm warnings in the admin UI. Never derived from anything other than the cert itself.';

-- ============================================================
-- VERIFICATION QUERIES
-- ============================================================
-- Run each query in the Supabase SQL editor after applying this
-- migration. Every query lists its expected output.

-- V1: Confirm all 5 new columns exist with the expected types.
-- SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_schema='public' AND table_name='sso_providers'
--     AND column_name IN (
--       'cert_fingerprint_sha256',
--       'cert_subject',
--       'cert_not_before',
--       'cert_not_after',
--       'cert_signature_algorithm'
--     )
--   ORDER BY column_name;
-- Expected: 5 rows, all is_nullable='YES':
--   cert_fingerprint_sha256   | text                     | YES
--   cert_not_after            | timestamp with time zone | YES
--   cert_not_before           | timestamp with time zone | YES
--   cert_signature_algorithm  | text                     | YES
--   cert_subject              | text                     | YES

-- V2: Confirm the partial fingerprint index exists.
-- SELECT indexname, indexdef FROM pg_indexes
--   WHERE schemaname='public' AND tablename='sso_providers'
--     AND indexname='idx_sso_providers_cert_fingerprint';
-- Expected: 1 row, indexdef contains
--   "(cert_fingerprint_sha256) WHERE (cert_fingerprint_sha256 IS NOT NULL)".

-- V3: Confirm column comments survived the migration.
-- SELECT cols.column_name, pgd.description
--   FROM information_schema.columns cols
--   JOIN pg_catalog.pg_statio_all_tables st
--     ON st.schemaname = cols.table_schema AND st.relname = cols.table_name
--   JOIN pg_catalog.pg_description pgd
--     ON pgd.objoid = st.relid AND pgd.objsubid = cols.ordinal_position
--   WHERE cols.table_schema='public' AND cols.table_name='sso_providers'
--     AND cols.column_name LIKE 'cert_%'
--   ORDER BY cols.column_name;
-- Expected: 5 rows, each with a non-empty description.
