import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'

// `ProjectsList.tsx` transitively imports `@/lib/actions/projects` which
// pulls in `lib/actions/migration-intelligence.ts` → the Anthropic SDK,
// whose constructor refuses to instantiate in jsdom. Stub the action
// surface (the tile only calls `createProject` from a "New project"
// button — not exercised in `ProjectCard` tests). Same pattern used by
// `tests/components/empty-mapping-state.test.tsx`.
vi.mock('@/lib/actions/projects', () => ({
  createProject: vi.fn().mockResolvedValue({ success: true, projectId: 'noop' }),
  deleteProject: vi.fn(),
  markProjectComplete: vi.fn(),
  reactivateProject: vi.fn(),
  archiveProject: vi.fn(),
}))
vi.mock('@/lib/actions/execution-package', () => ({
  getExecutionPackageUrl: vi.fn(),
}))
vi.mock('@/lib/hooks/useProjectRole', () => ({
  useProjectRole: () => ({
    role: 'admin',
    isLoading: false,
    isReady: true,
    isAdmin: true,
    isEditor: false,
    isViewer: false,
    can: () => true,
  }),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

import { ProjectCard } from '@/components/app/ProjectsList'
import type { ProjectWithStats } from '@/lib/types/database'
import type { ProjectStats } from '@/lib/quality/project-stats'

// ─────────────────────────────────────────────────────────────────────────────
// feat/dashboard-cleanup-reject-confirm — ProjectCard tile tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// The dashboard tile was reduced to project name (plus the Completed /
// Archived lifecycle badge) and a last-updated relative timestamp. The
// prior right-side stats cluster — Mapping Approvals count, Transforms
// count, BlockingPill — and the italic "Awaiting data ingestion" state
// label were removed: per-count progress is noise at the dashboard
// level and lives on the Mapping page / Migration Center.
//
// These tests pin the minimal card and guard against the dropped
// signals creeping back into the DOM. `projectStats` is still threaded
// through `ProjectWithStats` (it feeds the completed-project badge), so
// the fixtures keep populating it.

// ─── Fixtures ───────────────────────────────────────────────────────────────

function projectStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    state: 'mappings_generated',
    target: { approved: 52, total: 68, unmapped: 16, needsReview: 0, usedInMapping: 52, schemaTotal: 68, tables: 3 },
    source: { decided: 57, total: 70, usedInMapping: 57, tables: 5 },
    transforms: { complete: 15, total: 51 },
    blocking: 0,
    ...overrides,
  }
}

function project(overrides: Partial<ProjectWithStats> = {}): ProjectWithStats {
  return {
    id: 'proj-1',
    name: 'Epicor to Rootstock',
    source_label: 'Epicor',
    target_label: 'Rootstock',
    status: 'active',
    created_at: '2026-04-01T00:00:00Z',
    updated_at: '2026-05-06T00:00:00Z',
    completed_at: null,
    archived_at: null,
    // Legacy fields kept populated for the data layer; the tile no
    // longer reads them.
    totalSourceFields: 70,
    mappedFieldCount: 52,
    totalRows: 12000,
    blockingIssueCount: 0,
    warningCount: 0,
    totalTransforms: 0,
    savedTransforms: 0,
    needsTransformCount: 0,
    coveredTransformCount: 0,
    mappingApproved: 52,
    mappingTotal: 68,
    transformApplied: 0,
    transformScope: 51,
    transformNeedsWork: 36,
    readinessScore: null,
    currentPhase: 3,
    outputCount: 0,
    projectStats: projectStats(),
    ...overrides,
  }
}

const noop = () => {}

/** ISO string for a moment `ms` milliseconds before now. */
function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString()
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

// ─── Last-updated timestamp ────────────────────────────────────────────────

describe('ProjectCard — last-updated timestamp', () => {
  it('renders the project updated_at as a relative timestamp', () => {
    render(
      <ProjectCard
        project={project({ updated_at: agoIso(3 * DAY + HOUR) })}
        onUpdate={noop}
      />,
    )
    const stamp = screen.getByTestId('project-last-updated')
    expect(stamp).toHaveTextContent('Updated 3 days ago')
  })

  it('renders an hours-granularity relative timestamp for recent edits', () => {
    render(
      <ProjectCard
        project={project({ updated_at: agoIso(2 * HOUR + 60_000) })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByTestId('project-last-updated')).toHaveTextContent(
      'Updated 2h ago',
    )
  })

  it('archived tiles show the archived date instead of the updated stamp', () => {
    render(
      <ProjectCard
        project={project({
          status: 'archived',
          archived_at: '2026-05-01T00:00:00Z',
        })}
        onUpdate={noop}
      />,
    )
    const stamp = screen.getByTestId('project-last-updated')
    expect(stamp.textContent).toMatch(/^Archived /)
    expect(stamp.textContent).not.toMatch(/^Updated /)
  })
})

// ─── Dropped stats signals ─────────────────────────────────────────────────
//
// Negative pins: the mappings count, transforms count, blocking pill and
// state label were removed from the tile. If any of them is re-added by
// a future refactor, these tests fail immediately.

describe('ProjectCard — dropped stats signals', () => {
  it('does not render the Mapping Approvals count', () => {
    render(<ProjectCard project={project()} onUpdate={noop} />)
    expect(screen.queryByTestId('stat-target')).toBeNull()
    expect(screen.queryByText(/Mapping Approvals/)).toBeNull()
  })

  it('does not render the Transforms count', () => {
    render(<ProjectCard project={project()} onUpdate={noop} />)
    expect(screen.queryByTestId('stat-transforms')).toBeNull()
    expect(screen.queryByText(/Transforms:/)).toBeNull()
  })

  it('does not render the stats row container', () => {
    render(<ProjectCard project={project()} onUpdate={noop} />)
    expect(screen.queryByTestId('project-stats-row')).toBeNull()
  })

  it('does not render the BlockingPill even when blocking issues exist', () => {
    render(
      <ProjectCard
        project={project({ projectStats: projectStats({ blocking: 21 }) })}
        onUpdate={noop}
      />,
    )
    expect(screen.queryByTestId('blocking-pill')).toBeNull()
  })

  it('does not render the italic state label for an awaiting-data project', () => {
    render(
      <ProjectCard
        project={project({
          projectStats: projectStats({
            state: 'awaiting_data',
            target: { approved: 0, total: 0, unmapped: 0, needsReview: 0, usedInMapping: 0, schemaTotal: 0, tables: 0 },
            source: { decided: 0, total: 0, usedInMapping: 0, tables: 0 },
            transforms: { complete: 0, total: 0 },
          }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.queryByTestId('tile-state-label')).toBeNull()
  })

  it('renders no stats signals when projectStats is null (defensive)', () => {
    render(<ProjectCard project={project({ projectStats: null })} onUpdate={noop} />)
    expect(screen.queryByTestId('project-stats-row')).toBeNull()
    expect(screen.queryByTestId('tile-state-label')).toBeNull()
    expect(screen.queryByTestId('blocking-pill')).toBeNull()
    // The last-updated stamp still renders — it does not depend on stats.
    expect(screen.getByTestId('project-last-updated')).toBeInTheDocument()
  })
})

// ─── Preserved card content ────────────────────────────────────────────────

describe('ProjectCard — preserved name + lifecycle badges', () => {
  it('renders the project name and the source → target labels', () => {
    render(<ProjectCard project={project()} onUpdate={noop} />)
    expect(screen.getByText('Epicor to Rootstock')).toBeInTheDocument()
    expect(screen.getByText('Epicor')).toBeInTheDocument()
    expect(screen.getByText('Rootstock')).toBeInTheDocument()
  })

  it('still shows the green Completed badge for completed projects', () => {
    render(
      <ProjectCard
        project={project({
          status: 'completed',
          completed_at: '2026-05-06T00:00:00Z',
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Completed')).toBeInTheDocument()
  })

  it('still shows the Archived span and "Data purged" note for archived projects', () => {
    render(
      <ProjectCard
        project={project({
          status: 'archived',
          archived_at: '2026-05-01T00:00:00Z',
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.getByText(/Data purged/)).toBeInTheDocument()
  })
})
