import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type { TransformPageData } from '@/lib/actions/transformations'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 1 — transform dispatch test harness.
// ─────────────────────────────────────────────────────────────────────────────
//
// Verifies that the feature-flag dispatch at the top of the legacy
// `TransformContent` default export correctly routes to either the Phase 3
// redesign module or the legacy UI based on `projectInfo.useMappingRedesign`.
// Mirrors `mapping-dispatch.test.tsx` — same strategy, different module.

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock(
  '@/app/app/projects/[projectId]/transform/redesign/TransformContent',
  () => ({
    default: ({
      projectId,
      projectName,
    }: {
      projectId: string
      projectName: string
    }) => (
      <div data-testid="transform-redesign-marker">
        <span data-testid="redesign-project-id">{projectId}</span>
        <span data-testid="redesign-project-name">{projectName}</span>
      </div>
    ),
  })
)

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

// Server-action modules imported by the legacy Transform UI.
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

// ── Test setup ────────────────────────────────────────────────────────────────

const baseProjectInfo: ProjectInfo = {
  projectName: 'Test Project',
  sourceSystem: 'src',
  targetSystem: 'tgt',
  createdAt: '2026-01-01T00:00:00Z',
}

const emptyTransformData: TransformPageData = {
  datasets: [],
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

describe('TransformContent dispatch (Phase 3 flag gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches to the redesign component when useMappingRedesign is true', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: true }}
      />
    )

    expect(screen.getByTestId('transform-redesign-marker')).toBeInTheDocument()
    expect(screen.getByTestId('redesign-project-id')).toHaveTextContent(
      'proj-123'
    )
    expect(screen.getByTestId('redesign-project-name')).toHaveTextContent(
      'Heritage Core'
    )
  })

  it('falls through to the legacy UI when useMappingRedesign is false', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: false }}
      />
    )

    expect(
      screen.queryByTestId('transform-redesign-marker')
    ).not.toBeInTheDocument()
  })

  it('falls through to the legacy UI when useMappingRedesign is undefined (default)', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
        projectInfo={baseProjectInfo}
      />
    )

    expect(
      screen.queryByTestId('transform-redesign-marker')
    ).not.toBeInTheDocument()
  })

  it('falls through to the legacy UI when projectInfo is undefined', async () => {
    const TransformContent = await importTransformContent()

    render(
      <TransformContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={emptyTransformData}
      />
    )

    expect(
      screen.queryByTestId('transform-redesign-marker')
    ).not.toBeInTheDocument()
  })
})
