import { describe, it, expect } from 'vitest'

// Sanity check that the Vitest harness is wired up. Runs first in CI so
// a broken test config fails fast with a clear error before any business
// logic tests execute.
describe('test harness smoke', () => {
  it('vitest runs and basic assertions work', () => {
    expect(1 + 1).toBe(2)
    expect('settle').toContain('tle')
  })

  it('jsdom globals are available', () => {
    expect(typeof window).toBe('object')
    expect(typeof document).toBe('object')
  })

  it('@/ path alias resolves', async () => {
    // Import a tiny pure module to prove the alias is wired correctly.
    const mod = await import('@/lib/types/database')
    expect(mod).toBeDefined()
  })
})
