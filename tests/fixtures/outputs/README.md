# Golden-output fixtures — Prompt 3c

## What these fixtures test

Every customer-facing output produced by `lib/actions/outputs.ts`,
`lib/actions/execution-package.ts`, and the LLM prompts assembled inside them
is pinned to an expected string checked into this directory. Any change to
output format, SQL generation pattern, CSV columns, JSON shape, or LLM
prompt body produces a diff that MUST be an intentional behavior change.

One fixture file = one deterministic snapshot of a customer-facing artifact.
They are the last-line defense against "I didn't mean to change the SQL
output" bugs — the class of regression that lands wrong data in customer
production systems without anyone noticing.

## Files in this directory

| File | Pins |
|---|---|
| `seed.ts` | Hand-constructed scenario (2 TMs, 9 TFMs, 8 transformations, 1 source ack). Source of truth for every `.expected.*` file below. |
| `mapping-file.expected.csv` | `generateMappingFile(…, 'csv')` output |
| `mapping-file.expected.json` | `generateMappingFile(…, 'json')` output |
| `transform-specs.expected.sql` | `generateTransformSpecs(…, 'sql')` output |
| `gold-standard-sql.expected.sql` | `generateGoldStandardCSVs` fallback-path SQL (one per TM, concatenated) |
| `sql-load-scripts.expected.sql` | `generateSQLLoadScripts` fallback-path SQL (one per TM, concatenated) |
| `execution-package-prompt.monolithic.expected.md` | `generateExecutionPackage` `userMessage` |
| `execution-package-prompt.monolithic.params.json` | `{ systemPrompt, maxTokens }` for monolithic |
| `execution-package-prompt.compartmentalized.expected.md` | `generateCompartmentalizedPackage` per-table userMessages (concatenated with separators) |
| `execution-package-prompt.compartmentalized.params.json` | `{ systemPrompt, maxTokens }` for compartmentalized |
| `readiness-report-prompt.expected.md` | `generateReadinessReport` `userMessage` |
| `readiness-report-prompt.params.json` | `{ systemPrompt, maxTokens }` for readiness |

All `.expected.md` / `.expected.sql` / `.expected.csv` / `.expected.json` files
are plain text and viewable in any diff tool.

## When to update

Update a fixture ONLY when you intentionally changed the format, column set,
prompt structure, or data-model translation. Accidental drift is a bug — the
test failure is the alert, not an inconvenience.

**Legitimate updates** (PR should regenerate the fixture):

- Added a new column to the mapping-file CSV (explicit feature work)
- Adjusted the execution-package system prompt (explicit prompt tuning)
- Renamed an output section header (documented in the PR)
- Added a new coverage case to `seed.ts`

**Illegitimate updates** (fix your code, not the fixture):

- "The ordering changed" — ordering must be deterministic; if it changed your
  code is wrong, not the fixture
- "A confidence number shifted" — confidence is input data in `seed.ts`; if
  it changed without touching seed.ts, your code's math is wrong
- "The LLM produced different output" — fixtures snapshot the INPUT prompt,
  not the LLM response; if your prompt-assembly code didn't change, nothing
  should drift

## How to regenerate

```
UPDATE_FIXTURES=1 npx vitest tests/outputs/
```

The `UPDATE_FIXTURES=1` env var flips every golden-output test into write
mode: the test overwrites the `.expected.*` file with current output instead
of asserting. After running, review every diff carefully and commit only the
ones you intend.

If only a subset of fixtures needs updating, restrict the vitest path:

```
UPDATE_FIXTURES=1 npx vitest tests/outputs/mapping-file.golden.test.ts
```

## Fixture change process

When a fixture file changes, the commit message MUST include a line starting
with `Fixture change:` explaining the intentional behavior modification.
Example:

    Fixture change: added needs_transformation=false column to
    mapping-file output to support user-dismissed transform flag

Any fixture diff without this explicit justification is a bug. The test
failure is the alert; ignoring it without understanding why is exactly what
these fixtures exist to prevent.

Before committing fixture changes:

1. Run the diff mentally against your intent.
2. Confirm the format change is deliberate.
3. Include `Fixture change:` line in commit message explaining WHY.

Self-review discipline replaces external review at this company stage. The
discipline is the whole point — a fixture changed without conscious intent
is a silent customer-facing regression in disguise.

### Change log

Historical fixture adjustments that altered the seed scenario itself (as
opposed to regenerating goldens from legitimate output-code changes):

- **2026-04-22 — TFM-9 relocation (Flag 2).** TFM-9 previously targeted
  `t_orphan` on `t_orders` with source `s_first_name` on `s_customers`. No
  table_mapping owns the `(s_customers → t_orders)` pair in the fixture, so
  TFM-9 was silently dropped by the grouping pipeline and Test 11's
  rejected-TFM exclusion assertions were trivially satisfied. Relocated
  TFM-9 to `t_customers.t_deprecated_flag` (new target field, ord=6) with
  source `s_legacy_flag` so it is correctly owned by `tmCust` and actually
  exercises `groupTfmsWithRejected`. Test 11 now proves eight real
  assertions: inclusion in mapping-file CSV/JSON (audit trail), exclusion
  from transform-specs, gold-standard SELECT, SQL load inserts,
  readiness-report prompt, and both execution-package prompt variants'
  Approved Mappings sections. The removed `fTOrphan` field is no longer
  referenced.

  Commit message: `Fixture change: relocate TFM-9 to ensure rejected-TFM
  path exercises groupTfmsWithRejected loop and Test 11 exclusion
  assertions prove correctness.`

## Determinism contract

Golden fixtures are byte-stable across machines, OS locales, and CI runs.
The assert helper in `tests/outputs/_fixture-assert.ts` normalizes a short
list of known runtime-variable patterns (ISO timestamps, UTC date strings,
locale-formatted dates) to placeholder tokens before comparison. If you
introduce a new source of nondeterminism into the output path, EITHER:

1. Redact it in `_fixture-assert.ts`'s `redactVariableContent` (with a
   comment explaining why); OR
2. Remove the variable content from the output entirely (preferred when
   the variable content serves no customer purpose).

Do not add UUIDs, random values, or wall-clock reads to output generation
functions — they will immediately fail golden tests.
