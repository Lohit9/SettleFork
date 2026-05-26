// @vitest-environment node
//
// Source-level pins for lib/validation/self-correction.ts (S1 #5).
//
// runSelfCorrectionLoop requires live LLM + validator calls, so direct
// unit tests belong in integration tests. These source pins lock the 3
// exit-condition shapes, the UNRECOVERABLE_CHECKS set, and the
// correction-prompt structure so refactors can't silently remove them.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SRC = readFileSync(
  resolve(__dirname, '../../lib/validation/self-correction.ts'),
  'utf8',
)

// Strip block + line comments so prose mentions don't trip structural pins.
const CODE = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\/\/[^\n]*/g, '')

// ─── Constants ────────────────────────────────────────────────────────────────

describe('self-correction — HARD_ERROR_CHECKS set', () => {
  it('includes type_incompatible', () => {
    expect(SRC).toContain("'type_incompatible'")
  })

  it('includes fk_orphan_risk', () => {
    expect(SRC).toContain("'fk_orphan_risk'")
  })

  it('includes many_to_one_collision', () => {
    expect(SRC).toContain("'many_to_one_collision'")
  })
})

describe('self-correction — UNRECOVERABLE_CHECKS set', () => {
  it('exists and contains fk_circular_dependency', () => {
    expect(SRC).toContain('UNRECOVERABLE_CHECKS')
    expect(SRC).toContain("'fk_circular_dependency'")
  })

  it('contains fk_load_order_violation', () => {
    expect(SRC).toContain("'fk_load_order_violation'")
  })
})

describe('self-correction — MAX_CORRECTION_ITERATIONS cap', () => {
  it('is declared as a constant', () => {
    expect(CODE).toMatch(/const\s+MAX_CORRECTION_ITERATIONS\s*=\s*3/)
  })

  it('is used as the loop upper bound', () => {
    expect(CODE).toMatch(/iteration\s*<\s*MAX_CORRECTION_ITERATIONS/)
  })
})

// ─── Exit condition 1: UNRECOVERABLE ─────────────────────────────────────────

describe('self-correction — exit condition 1: UNRECOVERABLE', () => {
  it('checks allUnrecoverable before re-prompting', () => {
    expect(CODE).toMatch(/allUnrecoverable/)
  })

  it('uses UNRECOVERABLE_CHECKS.has() to classify errors', () => {
    expect(CODE).toMatch(/UNRECOVERABLE_CHECKS\.has\(/)
  })

  it('returns exitReason: unrecoverable', () => {
    expect(CODE).toMatch(/exitReason:\s*['"]unrecoverable['"]/)
  })
})

// ─── Exit condition 2: no improvement delta ───────────────────────────────────

describe('self-correction — exit condition 2: no improvement delta', () => {
  it('tracks previous error key for delta comparison', () => {
    expect(CODE).toMatch(/prevErrorKey/)
  })

  it('compares errorKey === prevErrorKey', () => {
    expect(CODE).toMatch(/errorKey\s*===\s*prevErrorKey/)
  })

  it('gates the comparison on iteration > 0', () => {
    expect(CODE).toMatch(/iteration\s*>\s*0\s*&&\s*errorKey\s*===\s*prevErrorKey|errorKey\s*===\s*prevErrorKey[\s\S]{0,50}iteration\s*>\s*0/)
  })

  it('returns exitReason: no_improvement', () => {
    expect(CODE).toMatch(/exitReason:\s*['"]no_improvement['"]/)
  })
})

// ─── Exit condition 3: hard cap ───────────────────────────────────────────────

describe('self-correction — exit condition 3: max iterations', () => {
  it('checks iteration === MAX_CORRECTION_ITERATIONS - 1', () => {
    expect(CODE).toMatch(/iteration\s*===\s*MAX_CORRECTION_ITERATIONS\s*-\s*1/)
  })

  it('returns exitReason: max_iterations', () => {
    expect(CODE).toMatch(/exitReason:\s*['"]max_iterations['"]/)
  })
})

// ─── Exit condition: clean ────────────────────────────────────────────────────

describe('self-correction — exit condition: clean', () => {
  it('exits when hardErrorFields.length === 0', () => {
    expect(CODE).toMatch(/hardErrorFields\.length\s*===\s*0/)
  })

  it('returns exitReason: clean', () => {
    expect(CODE).toMatch(/exitReason:\s*['"]clean['"]/)
  })
})

// ─── Correction prompt structure ──────────────────────────────────────────────

describe('self-correction — buildCorrectionPrompt', () => {
  it('emits <validation_errors> XML block', () => {
    expect(SRC).toContain('<validation_errors>')
    expect(SRC).toContain('</validation_errors>')
  })

  it('instructs LLM to fix via 3 strategies (different target, transform SQL, split/combine)', () => {
    expect(SRC).toMatch(/different target field/)
    expect(SRC).toMatch(/transform(?:ation)? SQL|adding a transform/)
  })

  it('warns LLM not to repeat the same mapping', () => {
    expect(SRC).toMatch(/NOT simply repeat the same mapping|same check will fail again/)
  })
})

// ─── CorrectionResult shape ───────────────────────────────────────────────────

describe('self-correction — CorrectionResult interface', () => {
  it('exports CorrectionResult with exitReason field', () => {
    expect(SRC).toContain('exitReason')
    expect(SRC).toMatch(/['"]clean['"]\s*\|\s*['"]unrecoverable['"]/)
  })

  it('includes unresolvableFields array', () => {
    expect(SRC).toContain('unresolvableFields')
  })

  it('includes correctionsApplied counter', () => {
    expect(SRC).toContain('correctionsApplied')
  })
})
