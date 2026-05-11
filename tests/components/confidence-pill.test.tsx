import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  CreateMappingForm,
  type AISuggestion,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/CreateMappingForm'
import type { SourceFieldWithState } from '@/lib/types/mappings-for-redesign'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 4a-4b — ConfidencePill component tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// `ConfidencePill` is colocated inside CreateMappingForm.tsx (per locked
// §5/§6 — keeps the AI Suggest visual surface in one file). To exercise
// the pill we drive the form into the `loaded` state by mocking
// `suggestMappingForTarget` and firing the in-form pill click. Tests
// query the pill by its `data-testid` and `data-threshold` attributes.

const { suggestMappingMock } = vi.hoisted(() => ({
  suggestMappingMock: vi.fn(),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  createFieldMapping: vi.fn(),
  suggestMappingForTarget: (...args: unknown[]) => suggestMappingMock(...args),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
}))

// ── Fixtures ────────────────────────────────────────────────────────────────

function field(overrides: Partial<SourceFieldWithState> = {}): SourceFieldWithState {
  return {
    id: 'sf-1',
    name: 'FIRST_NAME',
    dataType: 'VARCHAR',
    ordinalPosition: 0,
    sourceTable: { id: 'st-cif', name: 'CIF_MASTER' },
    mappingStatus: 'unmapped',
    sampleValues: ['Alpha'],
    isAcknowledged: false,
    isRejected: false,
    ...overrides,
  }
}

const sources: SourceFieldWithState[] = [
  field({ id: 'sf-1', name: 'FIRST_NAME' }),
]

function suggestion(overrides: Partial<AISuggestion> = {}): AISuggestion {
  return {
    sourceFieldIds: ['sf-1'],
    combinationType: 'single',
    confidence: 85,
    rationale: 'Strong name match.',
    ...overrides,
  }
}

async function renderLoaded(s: AISuggestion) {
  suggestMappingMock.mockResolvedValueOnce({ success: true, suggestion: s })
  render(
    <CreateMappingForm
      projectId="p1"
      targetField={{ id: 'tf-1', name: 'customer_name' }}
      availableSourceFields={sources}
      onSaveSuccess={() => {}}
      onCancel={() => {}}
      autoSuggest
    />,
  )
  // Auto-fired suggest resolves on next microtask. Wait for the loaded
  // surface to appear.
  await screen.findByTestId('create-mapping-form-suggest-loaded')
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('ConfidencePill — threshold band visualization', () => {
  it('renders "high" band for confidence ≥ 70', async () => {
    await renderLoaded(suggestion({ confidence: 85 }))
    const pill = screen.getByTestId('create-mapping-form-confidence-pill')
    expect(pill.dataset.threshold).toBe('high')
    expect(pill.textContent).toContain('Confident (85%)')
  })

  it('renders "possible" band for confidence 40-69', async () => {
    await renderLoaded(suggestion({ confidence: 55 }))
    const pill = screen.getByTestId('create-mapping-form-confidence-pill')
    expect(pill.dataset.threshold).toBe('possible')
    expect(pill.textContent).toContain('Possible match (55%)')
  })

  it('renders "uncertain" band for confidence < 40', async () => {
    await renderLoaded(suggestion({ confidence: 25 }))
    const pill = screen.getByTestId('create-mapping-form-confidence-pill')
    expect(pill.dataset.threshold).toBe('uncertain')
    expect(pill.textContent).toContain('Low confidence (25%)')
  })

  it('boundary 70 lands on "high" (>=)', async () => {
    await renderLoaded(suggestion({ confidence: 70 }))
    expect(
      screen.getByTestId('create-mapping-form-confidence-pill').dataset
        .threshold,
    ).toBe('high')
  })

  it('boundary 40 lands on "possible" (>=)', async () => {
    await renderLoaded(suggestion({ confidence: 40 }))
    expect(
      screen.getByTestId('create-mapping-form-confidence-pill').dataset
        .threshold,
    ).toBe('possible')
  })

  it('exposes the label as the pill title attribute (a11y per locked §5-OQ-1)', async () => {
    await renderLoaded(suggestion({ confidence: 85 }))
    const pill = screen.getByTestId('create-mapping-form-confidence-pill')
    // Plain span + visible text + title — no role attribute (matches
    // locked §5-OQ-1: surrounding context provides semantics).
    expect(pill.tagName.toLowerCase()).toBe('span')
    expect(pill.getAttribute('role')).toBeNull()
    expect(pill.getAttribute('title')).toBe('Confident (85%)')
  })
})
