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
// PR-2 (feat/project-tile-redesign) — ProjectCard tile tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// First test file for the Projects Dashboard tile. Pins the state-machine
// rendering contract introduced by PR-2:
//
//   awaiting_data        → "Awaiting data ingestion" badge, no stats row
//   data_ingested        → "Data ingested" badge, no stats row
//   mappings_generated   → "Ready for review" badge, 3 stats + blocking pill
//   Completed overlay    → "Completed" green badge regardless of state; stats
//                          still render when state === mappings_generated
//
// The defensive `projectStats === null` fallback also pins to
// `awaiting_data` (no stats row) so a data-layer regression doesn't blank
// the tile.

// ─── Fixtures ───────────────────────────────────────────────────────────────

function projectStats(overrides: Partial<ProjectStats> = {}): ProjectStats {
  return {
    state: 'mappings_generated',
    target: { approved: 52, total: 68, unmapped: 16 },
    source: { decided: 57, total: 70 },
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
    // Legacy fields kept populated for the data layer; tile no longer
    // reads them post-PR-2 (they retire in PR-3).
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

// ─── State machine — 3 states + null fallback ──────────────────────────────

describe('ProjectCard — state badge', () => {
  it('renders awaiting_data badge with no stats row', () => {
    render(
      <ProjectCard
        project={project({
          projectStats: projectStats({ state: 'awaiting_data', target: { approved: 0, total: 0, unmapped: 0 }, source: { decided: 0, total: 0 }, transforms: { complete: 0, total: 0 } }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Awaiting data ingestion')).toBeInTheDocument()
    expect(screen.queryByTestId('project-stats-row')).not.toBeInTheDocument()
  })

  it('renders data_ingested badge with no stats row', () => {
    render(
      <ProjectCard
        project={project({
          projectStats: projectStats({ state: 'data_ingested', target: { approved: 0, total: 68, unmapped: 68 }, source: { decided: 0, total: 70 }, transforms: { complete: 0, total: 0 } }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Data ingested')).toBeInTheDocument()
    expect(screen.queryByTestId('project-stats-row')).not.toBeInTheDocument()
  })

  it('renders mappings_generated badge AND stats row with 3 stats', () => {
    render(<ProjectCard project={project()} onUpdate={noop} />)
    expect(screen.getByText('Ready for review')).toBeInTheDocument()
    expect(screen.getByTestId('project-stats-row')).toBeInTheDocument()
    expect(screen.getByTestId('stat-target')).toHaveTextContent('Mapped: 52/68 fields')
    expect(screen.getByTestId('stat-source')).toHaveTextContent('Sources: 57/70')
    expect(screen.getByTestId('stat-transforms')).toHaveTextContent('Transforms: 15/51')
  })

  it('falls back to awaiting_data styling when projectStats is null', () => {
    render(<ProjectCard project={project({ projectStats: null })} onUpdate={noop} />)
    expect(screen.getByText('Awaiting data ingestion')).toBeInTheDocument()
    expect(screen.queryByTestId('project-stats-row')).not.toBeInTheDocument()
  })
})

// ─── Completed overlay ─────────────────────────────────────────────────────

describe('ProjectCard — Completed overlay', () => {
  it('shows green Completed badge when completed_at is set, regardless of underlying state', () => {
    render(
      <ProjectCard
        project={project({
          status: 'completed',
          completed_at: '2026-05-06T00:00:00Z',
          projectStats: projectStats({ state: 'mappings_generated' }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Completed')).toBeInTheDocument()
    // Stats still render — Completed is a badge overlay, not a stats gate.
    expect(screen.getByTestId('project-stats-row')).toBeInTheDocument()
  })

  it('shows Completed badge even if state is awaiting_data (overlay precedence)', () => {
    render(
      <ProjectCard
        project={project({
          status: 'completed',
          completed_at: '2026-05-06T00:00:00Z',
          projectStats: projectStats({ state: 'awaiting_data', target: { approved: 0, total: 0, unmapped: 0 }, source: { decided: 0, total: 0 }, transforms: { complete: 0, total: 0 } }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Completed')).toBeInTheDocument()
    // No stats — underlying state still gates the stats row.
    expect(screen.queryByTestId('project-stats-row')).not.toBeInTheDocument()
  })
})

// ─── Blocking pill — conditional render ────────────────────────────────────

describe('ProjectCard — BlockingPill', () => {
  it('renders the blocking pill when count > 0', () => {
    render(
      <ProjectCard
        project={project({ projectStats: projectStats({ blocking: 21 }) })}
        onUpdate={noop}
      />,
    )
    const pill = screen.getByTestId('blocking-pill')
    expect(pill).toHaveTextContent('Blocking: 21')
    expect(pill).toHaveAttribute('data-count', '21')
  })

  it('does NOT render the blocking pill when count === 0', () => {
    render(
      <ProjectCard
        project={project({ projectStats: projectStats({ blocking: 0 }) })}
        onUpdate={noop}
      />,
    )
    expect(screen.queryByTestId('blocking-pill')).not.toBeInTheDocument()
  })
})

// ─── Q2: transforms numerator uses saved + applied (not applied only) ──────

describe('ProjectCard — transforms.complete (Q2 redefinition)', () => {
  it('renders projectStats.transforms.complete (not legacy transformApplied)', () => {
    // Construct a fixture where the new field and the legacy field would
    // disagree: legacy `transformApplied=2` (applied-only) vs new
    // `transforms.complete=15` (saved+applied per Q2). The tile must read
    // the new field.
    render(
      <ProjectCard
        project={project({
          transformApplied: 2, // legacy field, NOT what the tile reads now
          transformScope: 51,
          projectStats: projectStats({ transforms: { complete: 15, total: 51 } }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByTestId('stat-transforms')).toHaveTextContent('Transforms: 15/51')
    expect(screen.getByTestId('stat-transforms')).not.toHaveTextContent('2/51')
  })
})

// ─── Q4: source axis (mapped ∪ acknowledged) ───────────────────────────────

describe('ProjectCard — source axis', () => {
  it('renders projectStats.source.decided/total as the source stat', () => {
    render(
      <ProjectCard
        project={project({
          projectStats: projectStats({ source: { decided: 57, total: 70 } }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByTestId('stat-source')).toHaveTextContent('Sources: 57/70')
  })
})

// ─── Archived tiles preserve no-stats behavior ─────────────────────────────

describe('ProjectCard — Archived', () => {
  it('strips stats entirely when status === archived (Q1 — data purged)', () => {
    render(
      <ProjectCard
        project={project({
          status: 'archived',
          archived_at: '2026-05-01T00:00:00Z',
          // Stats present in the type but the tile must not render them.
          projectStats: projectStats({ state: 'mappings_generated', blocking: 21 }),
        })}
        onUpdate={noop}
      />,
    )
    expect(screen.getByText('Archived')).toBeInTheDocument()
    expect(screen.queryByTestId('project-stats-row')).not.toBeInTheDocument()
    expect(screen.queryByTestId('blocking-pill')).not.toBeInTheDocument()
    // The state badge is suppressed for archived too — only the inline
    // "Archived" gray span shows.
    expect(screen.queryByText('Ready for review')).not.toBeInTheDocument()
  })
})
