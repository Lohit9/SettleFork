import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import {
  GenerateMappingsPanel,
  computePilotPhaseBoundaries,
  pickPilotPaddedDurationMs,
} from '@/app/app/projects/[projectId]/mapping/redesign/components/GenerateMappingsPanel'

// ─────────────────────────────────────────────────────────────────────────────
// GenerateMappingsPanel — Phase 4 empty-state CTA unit tests.
// ─────────────────────────────────────────────────────────────────────────────
//
// Pins the founder-locked behavior:
//   • Both source and target table panels render with all checkboxes
//     pre-checked at mount.
//   • Per-panel "Select all" / "Deselect all" toggle and "X of Y"
//     footer.
//   • Generate button disabled until both panels have ≥1 selection.
//   • Generate calls `generateMappings(projectId, srcIds, tgtIds)` from
//     `@/lib/actions/mappings-for-redesign`.
//   • Spinner overlay surfaces while the call is in flight, with an
//     elapsed-time counter starting at 0:00 and ticking each second.
//   • On success, fires `router.refresh()` and pushes a success toast.
//   • On failure, the error toast surfaces and the panel returns to
//     idle (overlay hidden, button re-enabled).
//   • Phase-2 "Loading mappings…" copy surfaces between server-action
//     resolution and parent unmount (~router.refresh window).
//
// Server-side gating only — the panel deliberately does NOT add a
// client-side role hook. Permission failures surface as error toasts
// carrying the action's `error` field.

// ── Mocks ────────────────────────────────────────────────────────────

const refreshMock = vi.fn()
const pushToastMock = vi.fn()
const generateMappingsMock = vi.fn()

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: refreshMock,
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}))

vi.mock('@/lib/contexts/ToastContext', () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useToast: () => ({ pushToast: pushToastMock, dismissToast: vi.fn() }),
}))

vi.mock('@/lib/actions/mappings-for-redesign', () => ({
  generateMappings: (...args: unknown[]) => generateMappingsMock(...args),
}))

// ── Fixtures ─────────────────────────────────────────────────────────

const PROJECT_ID = 'p-generate-test'

const SOURCE_TABLES = [
  { id: 'st-1', name: 'ACCT_MASTER', datasetName: 'legacy' },
  { id: 'st-2', name: 'CUST_MASTER', datasetName: 'legacy' },
]

const TARGET_TABLES = [
  { id: 'tt-1', name: 'accounts', datasetName: 'core' },
  { id: 'tt-2', name: 'customers', datasetName: 'core' },
]

function renderPanel() {
  return render(
    <GenerateMappingsPanel
      projectId={PROJECT_ID}
      sourceTables={SOURCE_TABLES}
      targetTables={TARGET_TABLES}
    />,
  )
}

// ── Lifecycle ────────────────────────────────────────────────────────

beforeEach(() => {
  refreshMock.mockReset()
  pushToastMock.mockReset()
  generateMappingsMock.mockReset()
  generateMappingsMock.mockResolvedValue({
    success: true,
    generated: 14,
    skipped: 0,
  })
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Initial render ───────────────────────────────────────────────────

describe('GenerateMappingsPanel — initial render', () => {
  it('renders both source and target panels with all checkboxes pre-checked', () => {
    renderPanel()
    expect(screen.getByTestId('generate-mappings-panel')).toBeInTheDocument()

    for (const t of SOURCE_TABLES) {
      const cb = screen.getByTestId(
        `generate-mappings-source-checkbox-${t.id}`,
      ) as HTMLInputElement
      expect(cb.checked).toBe(true)
    }
    for (const t of TARGET_TABLES) {
      const cb = screen.getByTestId(
        `generate-mappings-target-checkbox-${t.id}`,
      ) as HTMLInputElement
      expect(cb.checked).toBe(true)
    }
  })

  it('footer counts read "X of Y selected" with all selected at mount', () => {
    renderPanel()
    expect(screen.getByTestId('generate-mappings-source-count')).toHaveTextContent(
      '2 of 2 selected',
    )
    expect(screen.getByTestId('generate-mappings-target-count')).toHaveTextContent(
      '2 of 2 selected',
    )
  })

  it('Generate button is enabled at mount (both sides have selections)', () => {
    renderPanel()
    expect(screen.getByTestId('generate-mappings-submit')).toBeEnabled()
  })

  it('renders table names in font-mono', () => {
    renderPanel()
    const row = screen.getByTestId('generate-mappings-source-row-st-1')
    expect(row.querySelector('.font-mono')).not.toBeNull()
  })
})

// ── Toggle behavior ──────────────────────────────────────────────────

describe('GenerateMappingsPanel — toggle behavior', () => {
  it('clicking a checkbox toggles its selected state', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    const cb = screen.getByTestId(
      'generate-mappings-source-checkbox-st-1',
    ) as HTMLInputElement
    expect(cb.checked).toBe(true)
    await user.click(cb)
    expect(cb.checked).toBe(false)
    expect(
      screen.getByTestId('generate-mappings-source-count'),
    ).toHaveTextContent('1 of 2 selected')
  })

  it('header "Deselect all" clears the panel; clicking again selects all', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    const toggle = screen.getByTestId('generate-mappings-source-toggle-all')
    // At mount the header reads "Deselect all" because all are
    // pre-checked.
    expect(toggle).toHaveTextContent('Deselect all')
    await user.click(toggle)
    expect(
      (screen.getByTestId(
        'generate-mappings-source-checkbox-st-1',
      ) as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      (screen.getByTestId(
        'generate-mappings-source-checkbox-st-2',
      ) as HTMLInputElement).checked,
    ).toBe(false)
    expect(
      screen.getByTestId('generate-mappings-source-count'),
    ).toHaveTextContent('2 tables')
    // Header flips to "Select all".
    expect(toggle).toHaveTextContent('Select all')
    await user.click(toggle)
    expect(
      (screen.getByTestId(
        'generate-mappings-source-checkbox-st-1',
      ) as HTMLInputElement).checked,
    ).toBe(true)
    expect(
      (screen.getByTestId(
        'generate-mappings-source-checkbox-st-2',
      ) as HTMLInputElement).checked,
    ).toBe(true)
  })
})

// ── Generate button gating ───────────────────────────────────────────

describe('GenerateMappingsPanel — Generate button gating', () => {
  it('disables Generate when source panel has zero selections', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-source-toggle-all')) // → all off
    expect(screen.getByTestId('generate-mappings-submit')).toBeDisabled()
  })

  it('disables Generate when target panel has zero selections', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-target-toggle-all')) // → all off
    expect(screen.getByTestId('generate-mappings-submit')).toBeDisabled()
  })

  it('keeps Generate enabled if one panel partially selected and the other has selections', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(
      screen.getByTestId('generate-mappings-source-checkbox-st-1'),
    )
    expect(screen.getByTestId('generate-mappings-submit')).toBeEnabled()
  })
})

// ── Submit flow ──────────────────────────────────────────────────────

describe('GenerateMappingsPanel — submit flow', () => {
  it('calls generateMappings with the selected ids', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(
      screen.getByTestId('generate-mappings-source-checkbox-st-2'),
    ) // remove st-2
    await user.click(screen.getByTestId('generate-mappings-submit'))
    await waitFor(() => {
      expect(generateMappingsMock).toHaveBeenCalledTimes(1)
    })
    const [projectId, srcIds, tgtIds] = generateMappingsMock.mock.calls[0]
    expect(projectId).toBe(PROJECT_ID)
    expect((srcIds as string[]).sort()).toEqual(['st-1'])
    expect((tgtIds as string[]).sort()).toEqual(['tt-1', 'tt-2'])
  })

  it('shows the spinner overlay with elapsed counter while in flight', async () => {
    let resolve: (v: { success: boolean; generated: number }) => void = () => {}
    generateMappingsMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    expect(screen.getByTestId('generate-mappings-overlay')).toBeInTheDocument()
    expect(screen.getByTestId('generate-mappings-spinner')).toBeInTheDocument()
    expect(screen.getByTestId('generate-mappings-elapsed')).toHaveTextContent(
      'Elapsed: 0:00',
    )

    // Tick 7 seconds → counter reads 0:07.
    act(() => {
      vi.advanceTimersByTime(7000)
    })
    expect(screen.getByTestId('generate-mappings-elapsed')).toHaveTextContent(
      'Elapsed: 0:07',
    )

    // Tick over 1 minute → format wraps to M:SS.
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(screen.getByTestId('generate-mappings-elapsed')).toHaveTextContent(
      'Elapsed: 1:07',
    )

    // Resolve to drain the pending promise so React/test cleanup
    // doesn't leak a hanging microtask.
    await act(async () => {
      resolve({ success: true, generated: 0 })
    })
  })

  it('disables checkboxes and the toggle-all controls during in-flight generation', async () => {
    let resolve: (v: { success: boolean; generated: number }) => void = () => {}
    generateMappingsMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    expect(
      screen.getByTestId('generate-mappings-source-checkbox-st-1'),
    ).toBeDisabled()
    expect(
      screen.getByTestId('generate-mappings-target-checkbox-tt-1'),
    ).toBeDisabled()
    expect(
      screen.getByTestId('generate-mappings-source-toggle-all'),
    ).toBeDisabled()
    expect(screen.getByTestId('generate-mappings-submit')).toBeDisabled()

    await act(async () => {
      resolve({ success: true, generated: 0 })
    })
  })

  it('on success: switches the overlay to "Loading mappings…", fires router.refresh, and pushes a success toast', async () => {
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 14,
      skipped: 0,
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        message: 'Mappings generated.',
      }),
    )
    // Phase-2 overlay copy: "Loading mappings…" replaces the
    // generation copy until the parent unmounts the panel.
    expect(screen.getByTestId('generate-mappings-status')).toHaveTextContent(
      'Loading mappings…',
    )
  })

  it('success copy is count-free regardless of the skipped count', async () => {
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 12,
      skipped: 2,
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalled()
    })
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        message: 'Mappings generated.',
      }),
    )
  })

  it('on action failure: pushes an error toast and returns the panel to idle', async () => {
    generateMappingsMock.mockResolvedValue({
      success: false,
      error: 'Anthropic rate limit hit.',
    })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalled()
    })
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        message: 'Anthropic rate limit hit.',
      }),
    )
    // Overlay drops, button re-enabled, refresh NOT fired.
    expect(screen.queryByTestId('generate-mappings-overlay')).toBeNull()
    expect(screen.getByTestId('generate-mappings-submit')).toBeEnabled()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('on thrown error: catches and surfaces the error message in a toast', async () => {
    generateMappingsMock.mockRejectedValue(new Error('Network outage.'))
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalled()
    })
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'error',
        message: 'Network outage.',
      }),
    )
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('does NOT render any client-side role-tooltip wrapper around the Generate button (server-side gating only)', () => {
    renderPanel()
    const btn = screen.getByTestId('generate-mappings-submit')
    // The legacy panel wrapped this button in `<RoleTooltip allowed=…>`.
    // The redesign deliberately drops that surface — verify by
    // asserting the button is not nested inside any element carrying
    // a role-tooltip data-testid.
    let cur: HTMLElement | null = btn
    while (cur !== null) {
      const tid = cur.getAttribute('data-testid')
      if (tid !== null) {
        expect(tid).not.toMatch(/role-tooltip/i)
      }
      cur = cur.parentElement
    }
  })
})

// ── Static copy ──────────────────────────────────────────────────────

describe('GenerateMappingsPanel — static copy', () => {
  it('overlay shows the "1-3 minutes" copy (matches the legacy timing fix)', async () => {
    let resolve: (v: { success: boolean; generated: number }) => void = () => {}
    generateMappingsMock.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel()
    await user.click(screen.getByTestId('generate-mappings-submit'))
    expect(
      screen.getByText('This typically takes 1-3 minutes.'),
    ).toBeInTheDocument()
    await act(async () => {
      resolve({ success: true, generated: 0 })
    })
  })
})

// Quiet a vitest noise from `userEvent.setup` defaulting to fake-timer
// awareness; using `fireEvent` for one focused click flow avoids the
// timer-advancement race that surfaces in CI's deterministic clock.
describe('GenerateMappingsPanel — fireEvent click parity', () => {
  it('fireEvent.click on Generate triggers the same flow', async () => {
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 1,
      skipped: 0,
    })
    renderPanel()
    fireEvent.click(screen.getByTestId('generate-mappings-submit'))
    await waitFor(() => {
      expect(generateMappingsMock).toHaveBeenCalled()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Rootstock pilot — padded Generate-Mappings timing.
// ─────────────────────────────────────────────────────────────────────────────
//
// TODO(kaan): delete this block when the pilot padding is removed from
// `GenerateMappingsPanel.tsx`.
//
// Pins the gated behavior:
//   • For a gated pilot project the success path is held client-side
//     for a randomized 3-5 minute window before handing off (toast +
//     router.refresh). Six phase labels render in sequence.
//   • For every other project the flow is byte-identical to today —
//     immediate hand-off, no phase labels (covered above + explicitly
//     re-asserted here).
//   • The error path bypasses the padding entirely for gated projects.

describe('GenerateMappingsPanel — Rootstock pilot padded timing', () => {
  // One of the two ids in `PILOT_PADDED_TIMING_PROJECT_IDS`.
  const GATED_PROJECT_ID = 'eba53ac1-3d35-45ba-852d-a3fa3761850b'

  function renderGatedPanel() {
    return render(
      <GenerateMappingsPanel
        projectId={GATED_PROJECT_ID}
        sourceTables={SOURCE_TABLES}
        targetTables={TARGET_TABLES}
      />,
    )
  }

  it('gated project: runs all six phases and hands off after the padded window', async () => {
    // rand → 0.5 pins a 4-min run with zero boundary jitter.
    const randSpy = vi.spyOn(Math, 'random').mockReturnValue(0.5)
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 14,
      skipped: 0,
    })
    renderGatedPanel()

    fireEvent.click(screen.getByTestId('generate-mappings-submit'))

    // Phase 1 surfaces immediately; the server resolves fast but the
    // result is held — no refresh yet.
    await waitFor(() => {
      expect(
        screen.getByTestId('generate-mappings-phase-label'),
      ).toHaveTextContent('Profiling source schemas')
    })
    expect(refreshMock).not.toHaveBeenCalled()

    // Walk the five phase-advance boundaries. For a 4-min run with no
    // jitter the boundaries land at 24s/60s/120s/168s/216s — deltas
    // below.
    const steps: Array<[number, string]> = [
      [24_000, 'Building target field embeddings'],
      [36_000, 'Evaluating candidate pairings'],
      [60_000, 'Detecting multi-source patterns'],
      [48_000, 'Scoring confidence'],
      [48_000, 'Finalizing proposals'],
    ]
    for (const [delta, label] of steps) {
      act(() => {
        vi.advanceTimersByTime(delta)
      })
      expect(
        screen.getByTestId('generate-mappings-phase-label'),
      ).toHaveTextContent(label)
    }
    // Still inside the window (216s of 240s) — not finalized.
    expect(refreshMock).not.toHaveBeenCalled()

    // Cross the result-handoff deadline (216s → 240s).
    await act(async () => {
      vi.advanceTimersByTime(24_000)
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
    expect(pushToastMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'success',
        message: 'Mappings generated.',
      }),
    )
    randSpy.mockRestore()
  })

  it('gated project: holds the result until the padded duration elapses ([3min, 5min])', async () => {
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 5,
      skipped: 0,
    })
    renderGatedPanel()
    fireEvent.click(screen.getByTestId('generate-mappings-submit'))

    // Server resolves promptly.
    await waitFor(() => {
      expect(generateMappingsMock).toHaveBeenCalledTimes(1)
    })

    // Just under the 3-min floor — the result must still be held.
    act(() => {
      vi.advanceTimersByTime(179_000)
    })
    expect(refreshMock).not.toHaveBeenCalled()

    // Past the 5-min ceiling — must have handed off by now.
    await act(async () => {
      vi.advanceTimersByTime(121_000)
    })
    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
  })

  it('gated project: a server error surfaces immediately with no padded delay', async () => {
    generateMappingsMock.mockResolvedValue({
      success: false,
      error: 'Anthropic rate limit hit.',
    })
    renderGatedPanel()
    fireEvent.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          message: 'Anthropic rate limit hit.',
        }),
      )
    })
    // No artificial hold — overlay dropped, refresh never fired.
    expect(screen.queryByTestId('generate-mappings-overlay')).toBeNull()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('gated project: a thrown error surfaces immediately with no padded delay', async () => {
    generateMappingsMock.mockRejectedValue(new Error('Network outage.'))
    renderGatedPanel()
    fireEvent.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(pushToastMock).toHaveBeenCalledWith(
        expect.objectContaining({
          variant: 'error',
          message: 'Network outage.',
        }),
      )
    })
    expect(screen.queryByTestId('generate-mappings-overlay')).toBeNull()
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it('non-gated project: success hands off immediately with no phase labels', async () => {
    generateMappingsMock.mockResolvedValue({
      success: true,
      generated: 3,
      skipped: 0,
    })
    renderPanel() // non-gated PROJECT_ID
    fireEvent.click(screen.getByTestId('generate-mappings-submit'))

    await waitFor(() => {
      expect(refreshMock).toHaveBeenCalledTimes(1)
    })
    expect(screen.queryByTestId('generate-mappings-phase-label')).toBeNull()
  })
})

describe('GenerateMappingsPanel — pilot padded-timing helpers', () => {
  it('pickPilotPaddedDurationMs stays within [3min, 5min]', () => {
    expect(pickPilotPaddedDurationMs(() => 0)).toBe(180_000)
    expect(pickPilotPaddedDurationMs(() => 1)).toBe(300_000)
    expect(pickPilotPaddedDurationMs(() => 0.5)).toBe(240_000)
  })

  it('computePilotPhaseBoundaries returns 6 strictly increasing values ending at totalMs', () => {
    const boundaries = computePilotPhaseBoundaries(240_000)
    expect(boundaries).toHaveLength(6)
    for (let i = 1; i < boundaries.length; i += 1) {
      expect(boundaries[i]).toBeGreaterThan(boundaries[i - 1])
    }
    expect(boundaries[0]).toBeGreaterThan(0)
    expect(boundaries[4]).toBeLessThan(240_000)
    expect(boundaries[5]).toBe(240_000)
  })

  it('computePilotPhaseBoundaries with zero jitter sits on the cumulative weights', () => {
    // rand → 0.5 makes the jitter term zero.
    const boundaries = computePilotPhaseBoundaries(240_000, () => 0.5)
    expect(boundaries).toEqual([
      24_000, 60_000, 120_000, 168_000, 216_000, 240_000,
    ])
  })
})
