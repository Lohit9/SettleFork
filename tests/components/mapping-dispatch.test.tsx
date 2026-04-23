import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ProjectInfo } from '@/components/app/ProjectInfoPopover'
import type { MappingsResult } from '@/lib/actions/mappings'

// ─────────────────────────────────────────────────────────────────────────────
// Phase 3 Gap 1 — mapping dispatch test harness.
// ─────────────────────────────────────────────────────────────────────────────
//
// Verifies that the feature-flag dispatch at the top of the legacy
// `MappingContent` default export correctly routes to either the Phase 3
// redesign module or the legacy UI based on `projectInfo.useMappingRedesign`.
//
// We mock:
//   - `./redesign/MappingContent` → a lightweight marker component so we can
//     assert the dispatch routed through it.
//   - Every server-action module pulled in by the legacy UI, so jsdom does not
//     try to evaluate `'use server'` code paths at import time.
//   - `next/navigation` for the legacy fallthrough render.
//   - `useProjectRole` for the legacy fallthrough render.
//
// The legacy UI only has to render without crashing in the flag=false case —
// we assert on the *absence* of the redesign marker, not on any legacy chrome.

// ── Mocks (hoisted) ───────────────────────────────────────────────────────────

vi.mock(
  '@/app/app/projects/[projectId]/mapping/redesign/MappingContent',
  () => ({
    default: ({
      projectId,
      projectName,
    }: {
      projectId: string
      projectName: string
    }) => (
      <div data-testid="mapping-redesign-marker">
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
  usePathname: () => '/app/projects/p1/mapping',
  notFound: vi.fn(),
}))

vi.mock('@/lib/hooks/useProjectRole', () => ({
  useProjectRole: () => ({
    role: 'editor' as const,
    isLoading: false,
    can: () => true,
  }),
}))

// Server-action modules — return stub implementations so the module graph
// loads cleanly under jsdom. None of these are called during initial render
// with `initialData = null`, so the stubs never fire.
vi.mock('@/lib/actions/mappings', () => ({
  updateFieldMappingStatus: vi.fn(),
  editFieldMapping: vi.fn(),
  addManualFieldMapping: vi.fn(),
  addManualTableMapping: vi.fn(),
  deleteFieldMapping: vi.fn(),
  deleteTableMapping: vi.fn(),
  approveAllFieldMappings: vi.fn(),
  rejectAllFieldMappings: vi.fn(),
  suggestRemainingMappings: vi.fn(),
  regenerateFieldMappings: vi.fn(),
  generateMappings: vi.fn(),
  mapUnmappedField: vi.fn(),
  getMappings: vi.fn(),
  checkFieldMappingHasTransform: vi.fn(),
  handleTargetFieldConflict: vi.fn(),
}))

vi.mock('@/lib/actions/fk-cascade', () => ({
  checkPKSourceChangeImpact: vi.fn(),
}))

vi.mock('@/lib/actions/field-acknowledgments', () => ({
  acknowledgeField: vi.fn(),
  removeAcknowledgment: vi.fn(),
}))

// ── Test setup ────────────────────────────────────────────────────────────────

const baseProjectInfo: ProjectInfo = {
  projectName: 'Test Project',
  sourceSystem: 'src',
  targetSystem: 'tgt',
  createdAt: '2026-01-01T00:00:00Z',
}

async function importMappingContent() {
  const mod = await import(
    '@/app/app/projects/[projectId]/mapping/MappingContent'
  )
  return mod.default
}

describe('MappingContent dispatch (Phase 3 flag gate)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches to the redesign component when useMappingRedesign is true', async () => {
    const MappingContent = await importMappingContent()

    render(
      <MappingContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={null as MappingsResult | null}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: true }}
      />
    )

    expect(screen.getByTestId('mapping-redesign-marker')).toBeInTheDocument()
    expect(screen.getByTestId('redesign-project-id')).toHaveTextContent(
      'proj-123'
    )
    expect(screen.getByTestId('redesign-project-name')).toHaveTextContent(
      'Heritage Core'
    )
  })

  it('falls through to the legacy UI when useMappingRedesign is false', async () => {
    const MappingContent = await importMappingContent()

    render(
      <MappingContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={null as MappingsResult | null}
        projectInfo={{ ...baseProjectInfo, useMappingRedesign: false }}
      />
    )

    expect(
      screen.queryByTestId('mapping-redesign-marker')
    ).not.toBeInTheDocument()
  })

  it('falls through to the legacy UI when useMappingRedesign is undefined (default)', async () => {
    const MappingContent = await importMappingContent()

    render(
      <MappingContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={null as MappingsResult | null}
        projectInfo={baseProjectInfo}
      />
    )

    expect(
      screen.queryByTestId('mapping-redesign-marker')
    ).not.toBeInTheDocument()
  })

  it('falls through to the legacy UI when projectInfo is undefined', async () => {
    const MappingContent = await importMappingContent()

    render(
      <MappingContent
        projectId="proj-123"
        projectName="Heritage Core"
        initialData={null as MappingsResult | null}
      />
    )

    expect(
      screen.queryByTestId('mapping-redesign-marker')
    ).not.toBeInTheDocument()
  })
})
