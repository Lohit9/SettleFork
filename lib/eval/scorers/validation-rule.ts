/**
 * Phase 1 PR 10.3 — validation-rule structural scorer.
 *
 * Measures how close an AI's `validation_rule_from_nl` output is to a
 * gold rule across six axes:
 *
 *   - jsonValid:        AI returned a parseable object with all required fields  (weight 0.30)
 *   - ruleTypeMatch:    rule_type matches gold (strict string equality)          (weight 0.25)
 *   - fieldMatch:       field_id matches gold                                    (weight 0.20)
 *   - configKeysMatch:  sorted Object.keys(rule_config) match                    (weight 0.10)
 *   - configValuesMatch: deep-equal on rule_config (gated on configKeysMatch)    (weight 0.10)
 *   - severityMatch:    severity matches                                         (weight 0.05)
 *
 * Total possible = 1.0. Pure: no I/O, deterministic.
 *
 * Divergence from PR 10.3 spec: the production schema enforces
 * `severity IN ('blocking', 'warning')` (006_data_quality.sql:20), not
 * the spec's proposed `'error' | 'warning'`. The scorer's types use
 * the production literal set.
 *
 * Equal-weighting choice (locked at the values above per the original
 * Phase 1 investigation §3.4) is fixed for PR 10.3. Tunable weights
 * are a Phase 2 enhancement when there is signal on which axes
 * correlate with downstream success.
 */

// ─── Public input/output shapes ───────────────────────────────────────────────

/**
 * Mirrors the columns `addValidationRuleFromNL` writes into
 * `validation_rules` (lib/actions/validation-rules.ts:202-215).
 * `name` is optional — the production code always sets it but the
 * scorer doesn't grade naming.
 */
export type ProposedValidationRule = {
  rule_type: string
  rule_config: Record<string, unknown>
  field_id: string
  severity: 'blocking' | 'warning'
  name?: string
}

export type GoldValidationRule = ProposedValidationRule

/** Axis-weight constants — kept here so the scorer + tests stay aligned. */
const W_JSON_VALID = 0.3
const W_RULE_TYPE = 0.25
const W_FIELD = 0.2
const W_CONFIG_KEYS = 0.1
const W_CONFIG_VALUES = 0.1
const W_SEVERITY = 0.05

export type StructuralScoreDetails = {
  jsonValid: boolean
  ruleTypeMatch: boolean
  fieldMatch: boolean
  configKeysMatch: boolean
  configValuesMatch: boolean
  severityMatch: boolean
  axisScores: {
    jsonValid: number
    ruleTypeMatch: number
    fieldMatch: number
    configKeysMatch: number
    configValuesMatch: number
    severityMatch: number
  }
  goldKeys: string[]
  proposedKeys: string[]
  proposedRuleType?: string
  goldRuleType: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Strict deep-equal for JSON-shaped values. Implemented inline (no
 * lodash dependency).
 *
 * Edge-case decisions documented per the PR 10.3 spec §3:
 *   - Arrays compare position-by-position. `[a, b]` !== `[b, a]`.
 *     Pinned by the 'array config values, different order' test.
 *     Rationale: for `allowed_values` rule_config, list order can
 *     carry intent (e.g. preferred-default first). Strict ordering
 *     surfaces real disagreement; if Phase 2 evidence shows AI
 *     ordering is non-deterministic, this can soften.
 *   - Object key order is irrelevant — we iterate entries and compare
 *     by key.
 *   - `null` matches `null`; not `undefined`.
 *   - NaN never equals NaN (matches `===` semantics — gold should
 *     never carry NaN; if it does, the test surfaces the bug).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    const arrA = a as unknown[]
    const arrB = b as unknown[]
    if (arrA.length !== arrB.length) return false
    for (let i = 0; i < arrA.length; i++) {
      if (!deepEqual(arrA[i], arrB[i])) return false
    }
    return true
  }

  // Both are non-array objects.
  const objA = a as Record<string, unknown>
  const objB = b as Record<string, unknown>
  const keysA = Object.keys(objA)
  const keysB = Object.keys(objB)
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (!Object.prototype.hasOwnProperty.call(objB, k)) return false
    if (!deepEqual(objA[k], objB[k])) return false
  }
  return true
}

/**
 * `jsonValid` = the proposed object is non-null AND carries every
 * field a `validation_rules` row requires. Severity is required by
 * the schema's CHECK constraint; missing it means malformed.
 *
 * `rule_config` is checked for presence + object-shape. An array
 * passed for rule_config still passes jsonValid (the top-level
 * object is well-formed) but will fail configKeysMatch (per the
 * 'different shape' edge-case in PR 10.3 §3).
 */
function isStructurallyValid(p: ProposedValidationRule | null): p is ProposedValidationRule {
  if (p === null || p === undefined) return false
  if (typeof p !== 'object') return false
  if (typeof p.rule_type !== 'string' || p.rule_type.length === 0) return false
  if (typeof p.field_id !== 'string' || p.field_id.length === 0) return false
  if (p.severity !== 'blocking' && p.severity !== 'warning') return false
  if (p.rule_config === null || p.rule_config === undefined) return false
  if (typeof p.rule_config !== 'object') return false
  return true
}

// ─── Public scorer ────────────────────────────────────────────────────────────

/**
 * Score one AI validation rule against a gold rule. See the file
 * docstring for the axis weighting and edge-case decisions.
 *
 * Important detail: `configValuesMatch` is GATED on `configKeysMatch`.
 * If the keys differ, configValuesMatch is forced false even when
 * deep-equal would happen to return true on a malformed comparison.
 * This prevents AI from getting partial credit for "values match"
 * when the keys are different (logically impossible but worth pinning).
 */
export function scoreValidationRuleStructural(
  proposed: ProposedValidationRule | null,
  gold: GoldValidationRule,
): { score: number; details: StructuralScoreDetails } {
  const goldKeys = Object.keys(gold.rule_config).sort()

  // Short-circuit on malformed proposals: every axis is false, score 0.
  if (!isStructurallyValid(proposed)) {
    return {
      score: 0,
      details: {
        jsonValid: false,
        ruleTypeMatch: false,
        fieldMatch: false,
        configKeysMatch: false,
        configValuesMatch: false,
        severityMatch: false,
        axisScores: {
          jsonValid: 0,
          ruleTypeMatch: 0,
          fieldMatch: 0,
          configKeysMatch: 0,
          configValuesMatch: 0,
          severityMatch: 0,
        },
        goldKeys,
        proposedKeys: [],
        proposedRuleType: undefined,
        goldRuleType: gold.rule_type,
      },
    }
  }

  // Axis 2: rule_type strict equality (case-sensitive per the
  // 'case-sensitivity' edge-case in PR 10.3 §3).
  const ruleTypeMatch = proposed.rule_type === gold.rule_type

  // Axis 3: field_id strict equality.
  const fieldMatch = proposed.field_id === gold.field_id

  // Axes 4 + 5: config keys (sorted equality) + config values (gated).
  const proposedKeys = Object.keys(proposed.rule_config).sort()
  let configKeysMatch = false
  if (proposedKeys.length === goldKeys.length) {
    configKeysMatch = true
    for (let i = 0; i < proposedKeys.length; i++) {
      if (proposedKeys[i] !== goldKeys[i]) {
        configKeysMatch = false
        break
      }
    }
  }
  // Gate: configValuesMatch is only checked if configKeysMatch is true.
  // Otherwise the deep-equal would either fail trivially (different key
  // counts) or accidentally pass on a malformed comparison — neither is
  // the right answer.
  const configValuesMatch =
    configKeysMatch && deepEqual(proposed.rule_config, gold.rule_config)

  // Axis 6: severity strict equality.
  const severityMatch = proposed.severity === gold.severity

  // Score assembly.
  const axisScores = {
    jsonValid: W_JSON_VALID, // jsonValid is true here (we passed the guard above)
    ruleTypeMatch: ruleTypeMatch ? W_RULE_TYPE : 0,
    fieldMatch: fieldMatch ? W_FIELD : 0,
    configKeysMatch: configKeysMatch ? W_CONFIG_KEYS : 0,
    configValuesMatch: configValuesMatch ? W_CONFIG_VALUES : 0,
    severityMatch: severityMatch ? W_SEVERITY : 0,
  }
  const score =
    axisScores.jsonValid +
    axisScores.ruleTypeMatch +
    axisScores.fieldMatch +
    axisScores.configKeysMatch +
    axisScores.configValuesMatch +
    axisScores.severityMatch

  return {
    score,
    details: {
      jsonValid: true,
      ruleTypeMatch,
      fieldMatch,
      configKeysMatch,
      configValuesMatch,
      severityMatch,
      axisScores,
      goldKeys,
      proposedKeys,
      proposedRuleType: proposed.rule_type,
      goldRuleType: gold.rule_type,
    },
  }
}
