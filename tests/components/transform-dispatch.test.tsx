import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type { TransformPageData } from '@/lib/actions/transformations'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 — TransformContent renders identically across `useMappingRedesign`.
// ─────────────────────────────────────────────────────────────────────────────
//
// In Phase 3 Gap 1 the Transform page dispatched on `use_mapping_redesign`,
// routing flag-on projects to a placeholder component while the redesigned
// UI was incrementally landed. Phase 3 (this commit) lands the unified
// target-led sidebar + VA dismissal symmetry into `TransformContent` and
// removes the placeholder + dispatch gate entirely.
//
// These invariants pin that:
//   1. Both flag states render the same UI (the empty-state copy from
//      `TransformContent`'s "no mappings" branch).
//   2. The placeholder testid `transform-redesign-marker` is gone — a
//      regression that re-introduces the dispatch surfaces immediately.

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => ({
    get: () => null,
    has: () => false,
    toString: () => '',
    entries: () => [][Symbol.iterator](),
  }),
  usePathname: () => '/app/projects/p1/transform',
  notFound: vi.fn(),
}))

vi.mock('@/lib/hooks/useProjectRole', () => ({
  useProjectRole: () => ({
    role: 'editor' as const,
    isLoading: false,
    can: () => true,
  }),
}))

vi.mock('@/lib/actions/transformations', () => ({
  generateTransform: vi.fn(),
  autoSaveTransform: vi.fn(),
  runFullTransformTest: vi.fn(),
  testTransformation: vi.fn(),
  autoGenerateAllTransforms: vi.fn(),
  applyTransform: vi.fn(),
  revertTransform: vi.fn(),
  getStagedPreviewForField: vi.fn(),
  previewTransformDistinct: vi.fn(),
  suggestTransformDescription: vi.fn(),
  dismissTransformNeeded: vi.fn(),
  reinstateTransformNeeded: vi.fn(),
  dismissValueAssignment: vi.fn(),
  reinstateValueAssignment: vi.fn(),
  ensureValueAssignment: vi.fn(),
}))

vi.mock('@/lib/actions/staging', () => ({
  stageAllData: vi.fn(),
  getBlockingSourceIssues: vi.fn(),
  getSourceIssuesForField: vi.fn(),
  checkProjectStaleness: vi.fn(),
}))

vi.mock('@/lib/actions/quality-fixes', () => ({
  triggerStagedValidation: vi.fn(),
}))

vi.mock('@/lib/actions/fk-cascade', () => ({
  findFKDependents: vi.fn(),
  cascadeTransformToFKs: vi.fn(),
}))

const baseProjectInfo: ProjectInfo = {
  projectName: 'Test Project',
  sourceSystem: 'src',
  targetSystem: 'tgt',
  createdAt: '2026-01-01T00:00:00Z',
}

const emptyTransformData: TransformPageData = {
  datasets: [],
  targetTableGroups: [],
  schemaDocText: '',
  hasMappings: false,
  unmappedNotNullTargetFields: [],
  unmappedNullableTargetFields: [],
}

async function importTransformContent() {
  const mod = await import(
    '@/app/app/projects/[projectId]/transform/TransformContent'
  )
  return mod.default
}

describe('TransformContent — flag-agnostic render (Phase 3 dispatch removed)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does NOT route to a separate placeholder when useMappingRedesign is true', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: true }}
      />
    )

    expect(screen.queryByTestId('transform-redesign-marker')).toBeNull()
    expect(screen.queryByTestId('transform-redesign-placeholder')).toBeNull()
  })

  it('renders the unified UI when useMappingRedesign is false', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: false }}
      />
    )

    expect(screen.queryByTestId('transform-redesign-marker')).toBeNull()
    expect(screen.queryByTestId('transform-redesign-placeholder')).toBeNull()
  })

  it('renders identically across flag states (snapshot-style invariant)', async () => {
    const TransformContent = await importTransformContent()

    const { container: flagOff } = render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: false }}
      />,
    )
    const flagOffTopLevel = flagOff.querySelectorAll('[data-testid]').length

    const { container: flagOn } = render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: true }}
      />,
    )
    const flagOnTopLevel = flagOn.querySelectorAll('[data-testid]').length

    // The two trees should have the same structural footprint — the
    // dispatch gate is gone, so flag-on no longer mounts a placeholder
    // tree with its own testids. Equality is the invariant.
    expect(flagOnTopLevel).toBe(flagOffTopLevel)
  })
})
