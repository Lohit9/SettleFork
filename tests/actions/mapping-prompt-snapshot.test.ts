// @vitest-environment node
//
// DEMO-ONLY snapshot guard for MAPPING_GENERATION_SYSTEM_PROMPT.
//
// Pins the presence of the temporary Epicor Kinetic → Rootstock schema-
// detection + explicit-mappings block at the top of the prompt, plus the
// preservation of the original rule-based fallback (PRIMARY-MATCH /
// WEAK-OVERLAP rules) below it.
//
// THIS FILE WILL BE REMOVED POST-DEMO ALONGSIDE THE PROMPT REVERT PR.
//
// The guard is intentionally regex-free / substring-based so it tolerates
// whitespace shifts but trips on accidental deletion of the demo block or
// the rule-based fallback during the demo period.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

describe('MAPPING_GENERATION_SYSTEM_PROMPT', () => {
  it('contains the Epicor Kinetic to Rootstock schema detection block (DEMO-ONLY)', () => {
    const src = readFileSync(resolve(__dirname, '../../lib/actions/mappings.ts'), 'utf8')
    expect(src).toContain('EPICOR KINETIC TO ROOTSTOCK PATTERN')
    expect(src).toContain('EXPLICIT MAPPINGS — EPICOR KINETIC TO ROOTSTOCK')
  })

  it('preserves the original rule-based fallback for non-matching schemas', () => {
    const src = readFileSync(resolve(__dirname, '../../lib/actions/mappings.ts'), 'utf8')
    expect(src).toContain('PRIMARY-MATCH RULE')
    expect(src).toContain('WEAK-OVERLAP RULE')
  })
})
