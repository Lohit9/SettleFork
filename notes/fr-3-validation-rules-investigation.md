# FR-3 follow-up — `validation_rules` count in DeleteFieldImpact + AppliedCascade

> Stop 0 investigation. No code changes. Output of the fast-follow micro-PR to
> close the gap B caught during signature verification of PR #125.

---

## 1. Verdict

The gap is real and the fix is purely additive across four touch points
(two TS shapes, one preview action, one new migration, plus four lines of
test updates). The column name on `validation_rules` is **`field_id`** —
confirmed via the migration history; no rename has occurred since 006.
Recommend proceeding to Stop 1.

---

## 2. Column-name verification

The investigation prompt asked for an authoritative `information_schema`
check against the live Settle Supabase project (`uzfbwmiskqxwixxtlmye`).
This harness has no direct DB access, so the verification is done from
the migration history — which IS authoritative because the live schema
is the result of applying those migrations in order.

**Source-of-truth:** [`supabase/migrations/006_data_quality.sql:7-24`](supabase/migrations/006_data_quality.sql#L7-L24)

```sql
CREATE TABLE IF NOT EXISTS validation_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE NOT NULL,
  field_id UUID REFERENCES fields(id) ON DELETE CASCADE,        -- ← THIS
  table_id UUID REFERENCES tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  rule_type TEXT NOT NULL CHECK (rule_type IN (...)),
  rule_config JSONB NOT NULL DEFAULT '{}',
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('blocking', 'warning')),
  is_ai_generated BOOLEAN DEFAULT false,
  ai_original_prompt TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

**No subsequent rename or alter on the column.** Grepping every migration
for `validation_rules` returns only:

- `006_data_quality.sql` — original CREATE (above)
- `050_organizations.sql` — RLS policy refresh (no column changes)
- `079_project_rbac_strict_membership.sql` — RLS policy comment (mentions
  the table by name only)
- Many migrations referencing `validation_rules` inside regex allowlists
  inside other RPCs (e.g. `011`, `014`, `019`, `026`, `035`, `040`, `043`,
  `061`, `065`, `074`) — none touch the column set.

**Recommended confirmation step before Stop 1 ships:** run the
investigation prompt's `information_schema` query against the live
project. Expected return: a single row with `column_name = 'field_id'`.

```sql
SELECT column_name FROM information_schema.columns
WHERE table_name = 'validation_rules' AND column_name LIKE '%field%';
-- expected: field_id
```

If the live result differs from the migration-history conclusion, **stop
and escalate** — that would indicate an out-of-band schema mutation not
captured by `supabase/migrations/`, which is its own incident.

**Nullability note:** `field_id` is **nullable** in the table definition
— `validation_rules` can be field-scoped, table-scoped, or project-
scoped, and the column is NULL for the table/project variants. The fix
queries only count rows where `field_id = $1`, which (a) is the correct
semantic (only the field-scoped rows are affected by a field delete) and
(b) is the same behavior the FK CASCADE already exhibits on DELETE.

---

## 3. Code-state confirmations

### 3.1 Type shapes — additive points

Located in [`lib/validation/fields.ts`](lib/validation/fields.ts):

- `DeleteFieldImpactCounts` at lines **87-94** (6 fields today). Add
  `validationRules: number` as the 7th, appended after `coverageRows`
  to match the semantic ordering used by the preview's fan-out.
- `AppliedCascade` at lines **110-118** (6 count fields + a boolean).
  Add `validationRules: number` between `coverageRows` and the trailing
  `hadAuthoredTransformSql`. The boolean stays last so it visually
  separates from the cascade counts.

### 3.2 `previewFieldDeletion` fan-out

Located at [`lib/actions/fields.ts:317-444`](lib/actions/fields.ts#L317-L444).
The fan-out itself is at lines **376-418** — a 6-tuple destructured
`Promise.all`. The pattern uses:

```ts
supabaseAdmin
  .from('<table>')
  .select('id', { count: 'exact', head: true })
  .eq('<column>', fieldId)
```

…for every count that doesn't need a join. The new `validation_rules`
count fits this exact shape with no special-case handling:

```ts
supabaseAdmin
  .from('validation_rules')
  .select('id', { count: 'exact', head: true })
  .eq('field_id', fieldId)
```

The destructure adds a 7th binding (`vrRes`), and `counts.validationRules`
is populated via `(vrRes as { count: number | null }).count ?? 0` in the
result-shape construction at lines 424-435 (mirrors every other count
already there).

### 3.3 `deleteField` RPC unpack

Located at [`lib/actions/fields.ts:521-546`](lib/actions/fields.ts#L521-L546).
The `summary` type-assertion lists every key from the RPC's JSONB return
shape. Two additive lines needed:

- `validation_rules: number` inside the `cascade_counts` member of the
  `summary` cast (line ~534).
- `validationRules: summary.cascade_counts.validation_rules` in the
  `appliedCascade` construction (line ~544, between `coverageRows` and
  `hadAuthoredTransformSql`).

The activity-log call at lines 550-563 spreads `summary.cascade_counts`
into metadata; the new field rides along automatically with no edit.

### 3.4 Migration 099 — DO NOT amend

[`supabase/migrations/099_delete_field_with_cleanup_rpc.sql`](supabase/migrations/099_delete_field_with_cleanup_rpc.sql)
is intact (7331 bytes, applied to prod 2026-05-10 per user signal). No
`100_*.sql` exists yet. The user instruction is explicit: **ship a new
migration 100 using `CREATE OR REPLACE FUNCTION`** with the same body
plus the additive count.

Migration 100 will:
- Re-declare every variable from 099 plus `v_validation_rules_count INT`
- Insert one `SELECT count(*) INTO v_validation_rules_count FROM
  public.validation_rules WHERE field_id = p_field_id;` between the
  existing `v_coverage_count` query (099:117-118) and the staged-row
  scrub loop (099:120-134)
- Add `'validation_rules', v_validation_rules_count` to the
  `jsonb_build_object('cascade_counts', …)` at 099:148-155, positioned
  between `coverage_rows` and the closing paren — same ordering as
  `DeleteFieldImpactCounts`
- Keep the function signature (`(p_field_id UUID) RETURNS JSONB`), the
  `SECURITY DEFINER`, `search_path = public`, `statement_timeout = '60s'`,
  `LANGUAGE plpgsql` settings, and the `REVOKE ... FROM PUBLIC, anon` +
  `GRANT EXECUTE ... TO authenticated, service_role` posture identical
- Include a header comment referencing both 099 (the predecessor) and
  this micro-PR's motivation (B's UI work unblocking)

Because `CREATE OR REPLACE FUNCTION` only mutates the function body and
return shape (the signature stays `(p_field_id UUID) RETURNS JSONB`),
no callers break; the additive JSONB key simply appears in returned
results from the moment migration 100 applies.

---

## 4. Test impact

[`tests/integration/fields.test.ts`](tests/integration/fields.test.ts) has
two surfaces that need to stay aligned:

1. **The RPC stub** at lines 116-202. Its synthetic `cascade_counts`
   block at lines 189-196 must add `validation_rules` (default `0` is
   fine; the stub doesn't exercise live cascade counts). Without this,
   `summary.cascade_counts.validation_rules` is `undefined` and the
   `appliedCascade.validationRules` assignment becomes `NaN`-adjacent.

2. **Two `expect().toMatchObject` blocks**:
   - Lines 341-348 — `previewFieldDeletion` counts shape assertion.
     Add `validationRules: expect.any(Number)`.
   - Lines 400-408 — `deleteField` appliedCascade assertion. Add
     `validationRules: expect.any(Number)`.

3. **One zero-counts assertion** at lines 354-362 — optionally add
   `expect(result.data.counts.validationRules).toBe(0)` for symmetry
   with the existing `tfms`, `mappingSources`, `stagedRows` zero-checks.
   Not strictly required by the prompt; including it costs one line.

The test file is env-gated and runs only when `RUN_FIELDS_INTEGRATION=1`,
so the default CI suite is not affected by the stub updates. The default
suite (`npm test`) is, however, sensitive to type errors in the test
file — extending the stub's return type to include the new key is
necessary for the file to type-check cleanly.

---

## 5. Stop 1 changeset preview

Six touch points, all additive:

| # | File | Change | Est. LOC |
|---|---|---|---|
| 1 | [`lib/validation/fields.ts`](lib/validation/fields.ts) | `validationRules: number` on `DeleteFieldImpactCounts` + `AppliedCascade` | +2 |
| 2 | [`lib/actions/fields.ts`](lib/actions/fields.ts) — `previewFieldDeletion` | new `vrRes` query in fan-out; thread into `counts.validationRules` | +6 |
| 3 | [`lib/actions/fields.ts`](lib/actions/fields.ts) — `deleteField` | extend `summary` cast + `appliedCascade` construction | +2 |
| 4 | `supabase/migrations/100_delete_field_with_cleanup_validation_rules.sql` | NEW; `CREATE OR REPLACE FUNCTION` adding `v_validation_rules_count` + JSONB key | ~170 (~99's size + ~5) |
| 5 | [`tests/integration/fields.test.ts`](tests/integration/fields.test.ts) — RPC stub | `validation_rules: 0` in stub's `cascade_counts` | +1 |
| 6 | [`tests/integration/fields.test.ts`](tests/integration/fields.test.ts) — assertions | extend two `toMatchObject` blocks | +2 |

**Behavioural side-effects expected:** zero, beyond the new count showing
up in API responses. No semantic shift on any existing key.

**Cache/derived-state surfaces touched:** none. The activity-log payload
auto-picks up the new key via the existing `cascade_counts: summary.
cascade_counts` spread.

---

## 6. Migration apply protocol (anticipating Stop 1 → Stop 2)

Per the prompt's "MIGRATION APPLY PROTOCOL" + the standing convention
captured in user-memory ("Kaan applies SQL migrations via Supabase
Dashboard; PAUSE after writing the file and wait for verification
signal"):

1. After Stop 1 file writes (TS + migration 100), but BEFORE running
   tests, surface the migration 100 SQL and the smoke-check queries.
2. Pause for the **"applied"** signal.
3. Resume by running the full test suite, then opening the PR.

Anticipated smoke checks (run in Supabase SQL editor after applying 100):

```sql
-- 1. Signature is unchanged (still single UUID arg, returns JSONB)
SELECT proname, pg_get_function_arguments(oid) AS args,
       pg_get_function_result(oid) AS returns
FROM pg_proc
WHERE proname = 'delete_field_with_cleanup';
-- expect: delete_field_with_cleanup | p_field_id uuid | jsonb

-- 2. Grants are unchanged (authenticated + service_role only)
SELECT grantee, privilege_type
FROM information_schema.routine_privileges
WHERE routine_name = 'delete_field_with_cleanup';

-- 3. Auth gate still fires (run as anon)
SET LOCAL ROLE anon;
SELECT public.delete_field_with_cleanup('00000000-0000-0000-0000-000000000000'::uuid);
RESET ROLE;
-- expect: ERROR 28000 Not authenticated

-- 4. Not-found gate still fires (authenticated, fake uuid)
SELECT public.delete_field_with_cleanup('00000000-0000-0000-0000-000000000000'::uuid);
-- expect: ERROR P0001 Field not found

-- 5. (Optional, against a throwaway field on a scratch project) the JSONB
-- return now includes cascade_counts.validation_rules
```

---

## 7. Open questions / risks

- **Column-name authoritative confirmation.** The Stop 0 conclusion of
  `field_id` is derived from migration history. Recommend the operator
  run the `information_schema` query before Stop 1 begins, just to seal
  the loop. If the live schema disagrees with the migration history,
  that is itself an incident worth pausing for.

- **Stop 1 ordering convention.** I'm appending `validationRules` after
  `coverageRows` in every shape and in the fan-out. This matches the
  semantic order (cascade categories from the FR-3 wireframe: TFMs →
  sources → transformations → staged → acks → coverage → validation
  rules). Confirm the order is acceptable; if B's UI work needs a
  different position (e.g., right after `transformations`), reorder
  before code lands.

- **Pre/post-098 acknowledgments asymmetry, noted at PR #125 merge time,
  is unrelated** and out of scope for this micro-PR. No regression.

---

## 8. Recommendation

Proceed to Stop 1. Investigation surfaces no blockers; the only open
loop is the recommended live-DB column-name confirmation, which is
fast and de-risks the rest of the work.
