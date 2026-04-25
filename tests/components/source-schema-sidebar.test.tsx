/**
 * @file Phase 3 Gap 11a — `SourceSchemaSidebar` shell tests.
 *
 * Covers:
 *   - Collapsed-state rendering (vertical rail, label, count placeholder)
 *   - Expanded-state rendering (header, search, filter pills, list area)
 *   - State-toggle interaction (rail click expands; chevron click collapses)
 *   - Width values match the exported constants (28 / 200)
 *   - Aria labels and roles correct in both states
 *   - Focus management on user-initiated toggle (rail → chevron, chevron → rail)
 *
 * NOT covered (Gap 11b scope):
 *   - Filter logic over the fields list
 *   - Search wiring / debounce
 *   - Field rendering / hover tooltips / click highlight
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import {
  SIDEBAR_COLLAPSED_WIDTH_PX,
  SIDEBAR_EXPANDED_WIDTH_PX,
  SourceSchemaSidebar,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/SourceSchemaSidebar'
import type {
  SidebarFilter,
  SidebarState,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/useSidebarState'

interface RenderOptions {
  state?: SidebarState
  filter?: SidebarFilter
}

function renderSidebar(opts: RenderOptions = {}) {
  const onStateChange = vi.fn()
  const onFilterChange = vi.fn()
  const utils = render(
    <SourceSchemaSidebar
      state={opts.state ?? 'collapsed'}
      filter={opts.filter ?? 'unmapped'}
      onStateChange={onStateChange}
      onFilterChange={onFilterChange}
    />,
  )
  return { ...utils, onStateChange, onFilterChange }
}

describe('SourceSchemaSidebar — width invariant', () => {
  it('exports the locked founder widths (28 / 200)', () => {
    expect(SIDEBAR_COLLAPSED_WIDTH_PX).toBe(28)
    expect(SIDEBAR_EXPANDED_WIDTH_PX).toBe(200)
  })

  it('inline width is 28px when collapsed', () => {
    renderSidebar({ state: 'collapsed' })
    const aside = screen.getByTestId('source-schema-sidebar')
    expect(aside.style.width).toBe('28px')
  })

  it('inline width is 200px when expanded', () => {
    renderSidebar({ state: 'expanded' })
    const aside = screen.getByTestId('source-schema-sidebar')
    expect(aside.style.width).toBe('200px')
  })
})

describe('SourceSchemaSidebar — collapsed state', () => {
  beforeEach(() => {
    renderSidebar({ state: 'collapsed' })
  })

  it('renders the aside with the source-schema-browser aria-label', () => {
    const aside = screen.getByLabelText('Source schema browser')
    expect(aside.tagName).toBe('ASIDE')
  })

  it('exposes data-state="collapsed" for downstream styling/queries', () => {
    expect(
      screen.getByTestId('source-schema-sidebar').getAttribute('data-state'),
    ).toBe('collapsed')
  })

  it('renders the vertical rail as a button labelled "Expand source schema browser"', () => {
    const rail = screen.getByRole('button', {
      name: 'Expand source schema browser',
    })
    expect(rail).toBeInTheDocument()
    expect(rail.getAttribute('data-testid')).toBe('source-schema-sidebar-rail')
  })

  it('renders the vertical "Source fields" label', () => {
    const label = screen.getByText('Source fields')
    expect(label).toBeInTheDocument()
    // The vertical label uses the `[writing-mode:vertical-rl]` arbitrary
    // utility — assert the class is present so the visual contract is
    // regression-guarded against accidental Tailwind/CSS purges.
    expect(label.className).toContain('[writing-mode:vertical-rl]')
    expect(label.className).toContain('[transform:rotate(180deg)]')
  })

  it('renders the count placeholder ("—") inside the rail', () => {
    expect(screen.getByTestId('source-schema-sidebar-count')).toHaveTextContent(
      '—',
    )
  })

  it('does NOT render the close chevron, search, or filter pills', () => {
    expect(screen.queryByTestId('source-schema-sidebar-collapse')).toBeNull()
    expect(screen.queryByTestId('source-schema-sidebar-search')).toBeNull()
    expect(screen.queryByTestId('source-schema-sidebar-filter-all')).toBeNull()
  })

  it('top-anchors the label + count (justify-start, no bottom anchoring)', () => {
    // Founder amendment (2026-04-25): the rail's label/count block
    // must sit at the TOP of the rail so the affordance lands in the
    // user's first scan zone. Regression-guard against accidental
    // re-introduction of `justify-end` / `mt-auto` etc.
    const rail = screen.getByTestId('source-schema-sidebar-rail')
    expect(rail.className).toContain('justify-start')
    expect(rail.className).not.toContain('justify-end')
    expect(rail.className).not.toContain('justify-center')
    expect(rail.className).not.toContain('mt-auto')
  })
})

describe('SourceSchemaSidebar — expanded state', () => {
  it('renders the header with title and close chevron', () => {
    renderSidebar({ state: 'expanded' })
    expect(screen.getByText('Source fields')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Collapse source schema browser' }),
    ).toBeInTheDocument()
  })

  it('renders the search input with an accessible label', () => {
    renderSidebar({ state: 'expanded' })
    const search = screen.getByLabelText('Search source fields')
    expect(search.tagName).toBe('INPUT')
    expect(search.getAttribute('placeholder')).toBe('Search…')
  })

  it('renders the three filter pills (All / Mapped / Unmapped)', () => {
    renderSidebar({ state: 'expanded' })
    expect(
      screen.getByTestId('source-schema-sidebar-filter-all'),
    ).toHaveTextContent('All')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-mapped'),
    ).toHaveTextContent('Mapped')
    expect(
      screen.getByTestId('source-schema-sidebar-filter-unmapped'),
    ).toHaveTextContent('Unmapped')
  })

  it('marks the active filter pill with aria-pressed="true"', () => {
    renderSidebar({ state: 'expanded', filter: 'mapped' })
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-mapped')
        .getAttribute('aria-pressed'),
    ).toBe('true')
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-all')
        .getAttribute('aria-pressed'),
    ).toBe('false')
    expect(
      screen
        .getByTestId('source-schema-sidebar-filter-unmapped')
        .getAttribute('aria-pressed'),
    ).toBe('false')
  })

  it('renders the empty-state placeholder for the fields list', () => {
    renderSidebar({ state: 'expanded' })
    expect(
      screen.getByTestId('source-schema-sidebar-list'),
    ).toHaveTextContent('Source fields data coming in Gap 11b')
  })

  it('does NOT render the collapsed rail when expanded', () => {
    renderSidebar({ state: 'expanded' })
    expect(screen.queryByTestId('source-schema-sidebar-rail')).toBeNull()
  })

  it('groups the filter pills in a labelled region', () => {
    renderSidebar({ state: 'expanded' })
    const group = screen.getByRole('group', { name: 'Filter source fields' })
    expect(group).toBeInTheDocument()
  })
})

describe('SourceSchemaSidebar — interaction (Gap 11a)', () => {
  it('clicking the collapsed rail calls onStateChange("expanded")', () => {
    const { onStateChange } = renderSidebar({ state: 'collapsed' })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-rail'))
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith('expanded')
  })

  it('clicking the close chevron calls onStateChange("collapsed")', () => {
    const { onStateChange } = renderSidebar({ state: 'expanded' })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-collapse'))
    expect(onStateChange).toHaveBeenCalledTimes(1)
    expect(onStateChange).toHaveBeenCalledWith('collapsed')
  })

  it('clicking a filter pill calls onFilterChange with that value', () => {
    const { onFilterChange } = renderSidebar({
      state: 'expanded',
      filter: 'unmapped',
    })
    fireEvent.click(screen.getByTestId('source-schema-sidebar-filter-mapped'))
    expect(onFilterChange).toHaveBeenCalledTimes(1)
    expect(onFilterChange).toHaveBeenCalledWith('mapped')
  })
})

describe('SourceSchemaSidebar — focus management (Gap 11a)', () => {
  // Focus moves on USER-initiated toggles only. We simulate a user
  // click by firing the click handler, then re-render with the new
  // state (mirroring how the parent's `setSidebarState` would flow).
  // The focus-move effect runs after the state-change render commits.

  it('focuses the close chevron after the user clicks the rail to expand', () => {
    const onStateChange = vi.fn()
    const { rerender } = render(
      <SourceSchemaSidebar
        state="collapsed"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
      />,
    )
    // User click — flag the action as user-initiated inside the
    // component (the click handler sets `lastUserActionRef`).
    fireEvent.click(screen.getByTestId('source-schema-sidebar-rail'))
    // Parent now flips state to 'expanded'. Re-render with the new
    // prop. The focus effect should fire and move focus to the
    // chevron.
    rerender(
      <SourceSchemaSidebar
        state="expanded"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
      />,
    )
    expect(document.activeElement).toBe(
      screen.getByTestId('source-schema-sidebar-collapse'),
    )
  })

  it('focuses the rail after the user clicks the chevron to collapse', () => {
    const onStateChange = vi.fn()
    const { rerender } = render(
      <SourceSchemaSidebar
        state="expanded"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
      />,
    )
    fireEvent.click(screen.getByTestId('source-schema-sidebar-collapse'))
    rerender(
      <SourceSchemaSidebar
        state="collapsed"
        filter="unmapped"
        onStateChange={onStateChange}
        onFilterChange={vi.fn()}
      />,
    )
    expect(document.activeElement).toBe(
      screen.getByTestId('source-schema-sidebar-rail'),
    )
  })

  it('does NOT steal focus on a non-interactive state change (hydration pop)', () => {
    // Mount in 'collapsed' (no user click), then rerender as
    // 'expanded' simulating the hydration pass in `useSidebarState`.
    // Focus should remain on the previously-active body, not move to
    // the chevron.
    const onStateChange = vi.fn()
    const { rerender } = render(
      <>
        <button data-testid="external-trigger">trigger</button>
        <SourceSchemaSidebar
          state="collapsed"
          filter="unmapped"
          onStateChange={onStateChange}
          onFilterChange={vi.fn()}
        />
      </>,
    )
    const trigger = screen.getByTestId('external-trigger')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    rerender(
      <>
        <button data-testid="external-trigger">trigger</button>
        <SourceSchemaSidebar
          state="expanded"
          filter="unmapped"
          onStateChange={onStateChange}
          onFilterChange={vi.fn()}
        />
      </>,
    )
    expect(document.activeElement).toBe(trigger)
  })
})

describe('SourceSchemaSidebar — light-mode-only invariant', () => {
  it('rendered HTML contains no Tailwind dark-prefix classes (collapsed)', () => {
    const { container } = renderSidebar({ state: 'collapsed' })
    expect(container.innerHTML).not.toMatch(/\bdark:[a-z]/i)
  })

  it('rendered HTML contains no Tailwind dark-prefix classes (expanded)', () => {
    const { container } = renderSidebar({ state: 'expanded' })
    expect(container.innerHTML).not.toMatch(/\bdark:[a-z]/i)
  })
})
