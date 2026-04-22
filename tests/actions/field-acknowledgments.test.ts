import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Source-level contract tests for the rewritten
 * `lib/actions/field-acknowledgments.ts`.
 *
 * Behavioural tests with fully-mocked Supabase chainable builders for every
 * action in this file would be extremely brittle without a real-DB fixture
 * (the chainable API is proxy-heavy and the tests would need to keep pace
 * with internal implementation detail). The integration test in
 * `tests/integration/mappings-shim-heritage.test.ts` exercises the ack
 * paths against real data when `HERITAGE_PROJECT_ID` is set; here we check
 * the invariants that can be proven from the source text alone:
 *
 *   1. The three exported entry points (`acknowledgeField`,
 *      `removeAcknowledgment`, `getAcknowledgmentsForProject`) exist.
 *   2. Both write-path entry points reference `assertMappingWritesEnabled`
 *      (covered by the broader mappings-guard-sweep.test.ts parameterized
 *      sweep, but re-asserted here as a local invariant).
 *   3. Target-side acknowledgments route through the `dq_acknowledge_target`
 *      RPC rather than writing directly to `target_field_mappings` —
 *      the RPC wraps role check + is_acknowledged flip + source cleanup.
 *   4. Source-side acknowledgments go through the new
 *      `source_field_acknowledgments` table, not the legacy
 *      `field_acknowledgments` table (which was dropped in migration 074).
 *   5. The `resolveFieldSide` helper inspects `datasets.role` — the new
 *      model's single source of truth for target/source classification.
 */

const PATH = resolve(__dirname, '../../lib/actions/field-acknowledgments.ts')
const SOURCE = readFileSync(PATH, 'utf8')

describe('[field-acknowledgments] source contract', () => {
  it('exports acknowledgeField, removeAcknowledgment, getAcknowledgmentsForProject', () => {
    expect(SOURCE).toMatch(/export async function acknowledgeField\(/)
    expect(SOURCE).toMatch(/export async function removeAcknowledgment\(/)
    expect(SOURCE).toMatch(/export async function getAcknowledgmentsForProject\(/)
  })

  it('uses dq_acknowledge_target RPC for target-side acks', () => {
    expect(SOURCE).toContain("rpc('dq_acknowledge_target'")
  })

  it('writes source-side acks to source_field_acknowledgments (new table)', () => {
    expect(SOURCE).toContain("from('source_field_acknowledgments')")
    expect(SOURCE).not.toContain("from('field_acknowledgments')") // legacy table dropped
  })

  it('uses target_field_mappings with is_acknowledged=true for target removals', () => {
    // removeAcknowledgment must DELETE from target_field_mappings filtered
    // on is_acknowledged — the check constraint ckc_tfm_shape (migration
    // 074) forbids TFM rows with is_acknowledged=true AND sources, so we
    // delete outright instead of clearing the flag.
    expect(SOURCE).toMatch(/from\('target_field_mappings'\)[\s\S]{0,200}is_acknowledged/)
  })

  it('resolves field side via datasets.role', () => {
    expect(SOURCE).toContain("datasets:dataset_id(role)")
  })

  it('calls assertMappingWritesEnabled before any write (direct, not via guardWrites)', () => {
    // Acknowledgment APIs historically throw on error (see MappingContent.tsx
    // 3205-3236's try/catch). Preserving that contract means direct guard
    // calls so the thrown Error bubbles up verbatim.
    const acknowledgeBody = SOURCE.slice(
      SOURCE.indexOf('export async function acknowledgeField('),
      SOURCE.indexOf('export async function removeAcknowledgment('),
    )
    const removeBody = SOURCE.slice(
      SOURCE.indexOf('export async function removeAcknowledgment('),
      SOURCE.indexOf('export async function getAcknowledgmentsForProject('),
    )
    expect(acknowledgeBody).toContain('assertMappingWritesEnabled(')
    expect(removeBody).toContain('assertMappingWritesEnabled(')
  })

  it('folds notes into acknowledgment_reason for target side', () => {
    // See `reasonForStorage = notes ? \`${reason} \u2014 ${notes}\` : reason`.
    expect(SOURCE).toContain('reasonForStorage')
    expect(SOURCE).toContain('\u2014') // em-dash separator
  })
})
