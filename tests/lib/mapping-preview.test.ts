import { describe, expect, it } from 'vitest'
import {
  computeSamplePreview,
  SAMPLE_PREVIEW_DEFAULT_MAX,
} from '@/lib/utils/mapping-preview'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-2 — `computeSamplePreview` exhaustive unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// `computeSamplePreview` is a pure function; this file is the only test
// surface needed for the W1 form's sample-value preview. Tests cover:
//   • empty inputs (defensive)
//   • 'single' combination (head-cap + overflow)
//   • 'concat_space' / 'concat_comma' (zip-by-min-length, separators)
//   • unequal sample counts (apply-time semantics)
//   • all-empty source samples (degenerate zip)
//   • `max` boundary cases (exactly N, N±1)
//   • 3+ sources concat
//   • 'single' with multiple selected fields (defensive — sources[0] wins)

const f = (id: string, samples: string[]) => ({ id, sampleValues: samples })

describe('computeSamplePreview — empty inputs', () => {
  it('returns empty preview when selectedFields is empty (single)', () => {
    expect(computeSamplePreview([], 'single')).toEqual({
      preview: [],
      overflow: 0,
    })
  })

  it('returns empty preview when selectedFields is empty (concat_space)', () => {
    expect(computeSamplePreview([], 'concat_space')).toEqual({
      preview: [],
      overflow: 0,
    })
  })

  it('returns empty preview when selectedFields is empty (concat_comma)', () => {
    expect(computeSamplePreview([], 'concat_comma')).toEqual({
      preview: [],
      overflow: 0,
    })
  })
})

describe('computeSamplePreview — single combination', () => {
  it('returns first source samples head-capped at default max=3', () => {
    const result = computeSamplePreview(
      [f('a', ['1', '2', '3', '4', '5'])],
      'single',
    )
    expect(result.preview).toEqual(['1', '2', '3'])
    expect(result.overflow).toBe(2)
  })

  it('returns all samples when count <= max', () => {
    const result = computeSamplePreview([f('a', ['x', 'y'])], 'single')
    expect(result.preview).toEqual(['x', 'y'])
    expect(result.overflow).toBe(0)
  })

  it('returns empty preview when source has zero samples', () => {
    expect(computeSamplePreview([f('a', [])], 'single')).toEqual({
      preview: [],
      overflow: 0,
    })
  })

  it('respects custom max parameter', () => {
    const result = computeSamplePreview(
      [f('a', ['1', '2', '3', '4', '5'])],
      'single',
      2,
    )
    expect(result.preview).toEqual(['1', '2'])
    expect(result.overflow).toBe(3)
  })

  it('exposes SAMPLE_PREVIEW_DEFAULT_MAX = 3 (regression guard)', () => {
    expect(SAMPLE_PREVIEW_DEFAULT_MAX).toBe(3)
  })

  it('defensively uses sources[0] when 2+ fields passed with single (founder decision §5-OQ-2)', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe']),
        f('b', ['John', 'Jane']),
      ],
      'single',
    )
    expect(result.preview).toEqual(['Smith', 'Doe'])
    expect(result.overflow).toBe(0)
  })
})

describe('computeSamplePreview — concat_space', () => {
  it('zips equal-length pairs joined with space', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe']),
        f('b', ['John', 'Jane']),
      ],
      'concat_space',
    )
    expect(result.preview).toEqual(['Smith John', 'Doe Jane'])
    expect(result.overflow).toBe(0)
  })

  it('zips unequal-length arrays by min-length, drops longer tail', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe', 'Roe']),
        f('b', ['John', 'Jane']),
      ],
      'concat_space',
    )
    expect(result.preview).toEqual(['Smith John', 'Doe Jane'])
    expect(result.overflow).toBe(0)
  })

  it('returns empty preview when any source has zero samples', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe']),
        f('b', []),
      ],
      'concat_space',
    )
    expect(result.preview).toEqual([])
    expect(result.overflow).toBe(0)
  })

  it('zips three sources with space separator', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe']),
        f('b', ['John', 'Jane']),
        f('c', ['Sr.', 'Jr.']),
      ],
      'concat_space',
    )
    expect(result.preview).toEqual(['Smith John Sr.', 'Doe Jane Jr.'])
    expect(result.overflow).toBe(0)
  })

  it('head-caps at max when zipped count exceeds it', () => {
    const result = computeSamplePreview(
      [
        f('a', ['1', '2', '3', '4', '5']),
        f('b', ['a', 'b', 'c', 'd', 'e']),
      ],
      'concat_space',
    )
    expect(result.preview).toEqual(['1 a', '2 b', '3 c'])
    expect(result.overflow).toBe(2)
  })
})

describe('computeSamplePreview — concat_comma', () => {
  it('zips equal-length pairs joined with comma+space', () => {
    const result = computeSamplePreview(
      [
        f('a', ['Smith', 'Doe']),
        f('b', ['John', 'Jane']),
      ],
      'concat_comma',
    )
    expect(result.preview).toEqual(['Smith, John', 'Doe, Jane'])
    expect(result.overflow).toBe(0)
  })

  it('uses ", " as separator (not just comma)', () => {
    const result = computeSamplePreview(
      [
        f('a', ['x']),
        f('b', ['y']),
      ],
      'concat_comma',
    )
    expect(result.preview[0]).toBe('x, y')
  })
})

describe('computeSamplePreview — max boundary', () => {
  it('exactly max items: returns all, overflow=0', () => {
    const result = computeSamplePreview(
      [
        f('a', ['1', '2', '3']),
        f('b', ['a', 'b', 'c']),
      ],
      'concat_space',
    )
    expect(result.preview).toHaveLength(3)
    expect(result.overflow).toBe(0)
  })

  it('max+1 items: returns first max, overflow=1', () => {
    const result = computeSamplePreview(
      [
        f('a', ['1', '2', '3', '4']),
        f('b', ['a', 'b', 'c', 'd']),
      ],
      'concat_space',
    )
    expect(result.preview).toHaveLength(3)
    expect(result.overflow).toBe(1)
  })

  it('max-1 items: returns all, overflow=0', () => {
    const result = computeSamplePreview(
      [
        f('a', ['1', '2']),
        f('b', ['a', 'b']),
      ],
      'concat_space',
    )
    expect(result.preview).toHaveLength(2)
    expect(result.overflow).toBe(0)
  })

  it('max=0 returns empty preview with overflow = full min-length', () => {
    const result = computeSamplePreview(
      [
        f('a', ['1', '2']),
        f('b', ['a', 'b']),
      ],
      'concat_space',
      0,
    )
    expect(result.preview).toEqual([])
    expect(result.overflow).toBe(2)
  })
})

describe('computeSamplePreview — type defensiveness', () => {
  it('handles single-source concat input gracefully (zip of length 1)', () => {
    // Edge case: form should never emit concat_* with 1 source, but the
    // helper must not throw. min-length is the lone source's length.
    const result = computeSamplePreview(
      [f('a', ['x', 'y'])],
      'concat_space',
    )
    expect(result.preview).toEqual(['x', 'y'])
    expect(result.overflow).toBe(0)
  })

  it('overflow never goes negative when max > samples available', () => {
    const result = computeSamplePreview([f('a', ['x'])], 'single', 10)
    expect(result.overflow).toBe(0)
  })
})
