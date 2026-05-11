# Path D confidence — follow-ups

Captured from [notes/flat-view-confidence-bug.md](flat-view-confidence-bug.md) §10 during the
`fix/path-d-mapping-sources-confidence` ship. Not in scope for this PR.

---

## F1. Trigger semantics — guard against all-NULL overwrite

**Context:** `mapping_sources_confidence_recompute`
([supabase/migrations/074_mapping_redesign_data_migration.sql:356-388](../supabase/migrations/074_mapping_redesign_data_migration.sql#L356-L388))
runs `SET TFM.confidence = MIN(mapping_sources.confidence)` for every
non-custom_sql, non-acknowledged TFM after any mapping_sources DML.

When the source set is fully NULL the MIN is NULL and the trigger clobbers
the TFM's existing confidence. The flat-view bug originated from this
behaviour: Path D wrote a meaningful TFM.confidence in Pass 2, then Pass
2.5 inserted NULL-confidence sources and the trigger overwrote it.

The Pass 2.5 fix (this PR) propagates the parent's confidence onto every
source row, so the trigger now sees a non-NULL MIN. The TFM is safe.

**The trigger itself is still load-bearing on the assumption that
something good will populate ms.confidence.** A future writer that
violates that assumption (e.g. a partial-update path that NULLs out one
source's confidence as a side effect) would resurface the same class of
bug. Two design options to consider when this becomes a recurring concern:

- **Option A — coalesce-against-existing:** rewrite the trigger as
  `SET confidence = COALESCE((SELECT MIN(...) FROM ms ...), tfm.confidence)`
  so an all-NULL source set preserves whatever TFM.confidence currently
  holds. Safer default; defensible because "NULL MIN" really means
  "no signal", and "no signal" should not erase a prior signal.
- **Option B — narrow the trigger's WHERE:** only run the MIN-update when
  at least one mapping_source has a non-NULL confidence. Skips the
  no-op when nothing has been said.

Either change is a migration. Defer until the next time the bug class
surfaces (or until a separate cleanup ships in the trigger neighbourhood).

**Investigation hook:** add a trigger-level test in
[tests/integration/](../tests/integration/) that pins the current "MIN of
all-NULL overwrites to NULL" behaviour. If we ever change the trigger,
this test catches the contract shift.

---

## F2. Per-source confidence on the Path D wire

`MappingPayload.confidence` ([lib/ai/path-d-parser.ts:49](../lib/ai/path-d-parser.ts#L49))
is currently one number per mapping. The fix duplicates that value across
all contributing source rows.

If Path D ever wants to express asymmetric per-source signal ("source A
is a strong hit; source B is a weaker contributor we're including
because of column-name alignment"), the schema needs:

- `source_confidences: z.array(z.number().min(0).max(1)).optional()`
  alongside `source_field_ids`, with length-matching enforced in
  the parser.
- Persistence reads `source_confidences[ord]` per row instead of the
  shared `confidence` value.
- System prompt updated to instruct the model to emit per-source
  confidence when sources are heterogeneous.

The MIN trigger continues to work unchanged — it always operates on
whatever's persisted.

Defer until a calibration evaluation surfaces per-source asymmetry as a
real signal worth capturing. Today's MappingPayload shape is fine.

---

## F3. Backfill — separate from this code PR

Per the implementation prompt, backfill is NOT in this PR. After merge
+ dev propagation, re-run Path D on Test #7 (project
`0f2a95bb-1e80-4a8b-8e59-ae5559277730`) from the UI. Verify with:

```sql
SELECT
  count(*) FILTER (WHERE confidence IS NULL) AS null_count,
  count(*) FILTER (WHERE confidence > 0 AND confidence <= 1) AS in_range,
  count(*) AS total
FROM public.mapping_sources ms
JOIN public.target_field_mappings tfm
  ON ms.target_field_mapping_id = tfm.id
WHERE tfm.project_id = '0f2a95bb-1e80-4a8b-8e59-ae5559277730';
```

Expected: `null_count = 0`, `in_range = total`.

Other affected projects can be discovered with a similar `null_count > 0`
query scoped per project. Each gets a Path D re-run as its own follow-up.
