'use client'

// ─────────────────────────────────────────────────────────────────────────────
// GenerateMappingsPanel — Phase 4 empty-state CTA.
// ─────────────────────────────────────────────────────────────────────────────
//
// Ports the legacy `GenerateMappingsPanel` + `TableSelector` from
// `app/app/projects/[projectId]/mapping/MappingContent.tsx:132-305` into the
// redesigned chrome. Surfaces only when:
//
//   data.targetSchemaEmpty === false
//   && data.sourceTables.length > 0
//   && counts.total > 0
//   && counts.total === counts.unmapped
//
// (Case 4 of the empty-state discriminator. See `EmptyMappingState.tsx`.)
//
// Behavior parity with legacy
// ───────────────────────────
//
//   • Two `TableSelector` panels (source on left, target on right) with all
//     tables pre-checked.
//   • Per-panel "Select all" / "Deselect all" toggle and "X of Y selected"
//     footer.
//   • Generate button disabled until both panels have ≥1 selection AND we're
//     not currently generating.
//   • On click, calls `generateMappings(projectId, [...src], [...tgt])`
//     (re-exported from `@/lib/actions/mappings-for-redesign`).
//   • Spinner overlay during the AI call. Two-phase overlay: while the
//     server action is running we show "Generating AI-powered mappings…"
//     with an elapsed counter; after it resolves we briefly show "Loading
//     mappings…" while the parent fires `router.refresh()` and the new
//     server payload hydrates. The parent unmounts the panel when the data
//     swaps out of empty-state — that ends the "Loading mappings…" phase.
//
// Restyle to redesign system
// ──────────────────────────
//
//   • slate palette instead of gray (border-slate-200, text-slate-700, …).
//   • Lucide `Loader2` instead of inline svg spinner.
//   • Primary button: `bg-blue-600 text-white hover:bg-blue-700` (matches
//     `InlineSourcePicker` Save).
//   • Cancel-style button uses `bg-white border-slate-300` + slate hover.
//   • Table names rendered with `font-mono` (matches the redesign Mapping
//     row identity styling).
//
// Server-side gating only
// ───────────────────────
//
// The redesign deliberately does NOT replicate the legacy `RoleTooltip` /
// `useProjectRole` client-side gate. `generateMappings` enforces editor
// permission server-side via `requireProjectPermission(..., 'editor')` and
// maintenance-mode via `guardWrites(...)`. Failures surface as an error
// toast carrying the action's `error` message. This matches every other
// redesign mutation (approve, reject, acknowledge, edit-mapping-sources, …).

import { useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'

import { cn } from '@/components/ui/utils'
import { useToast } from '@/lib/contexts/ToastContext'
import { generateMappings } from '@/lib/actions/mappings-for-redesign'

interface TableForSelector {
  id: string
  name: string
  datasetName: string
}

// ─── TableSelector ───────────────────────────────────────────────────

interface TableSelectorProps {
  title: string
  testIdPrefix: string
  tables: TableForSelector[]
  selected: Set<string>
  onToggle: (id: string) => void
  onToggleAll: () => void
  disabled?: boolean
}

function TableSelector({
  title,
  testIdPrefix,
  tables,
  selected,
  onToggle,
  onToggleAll,
  disabled = false,
}: TableSelectorProps) {
  const allSelected = tables.length > 0 && tables.every((t) => selected.has(t.id))
  // Footer count only counts selections that still belong to `tables` so
  // the "X of Y" stays internally consistent if `tables` ever changes
  // shape underneath us (e.g. a future re-fetch). Matches legacy.
  const selectedInTablesCount = useMemo(() => {
    let n = 0
    for (const t of tables) if (selected.has(t.id)) n += 1
    return n
  }, [tables, selected])

  return (
    <div
      data-testid={`${testIdPrefix}-panel`}
      className="flex flex-col rounded-lg border border-slate-200 bg-white"
    >
      <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2.5">
        <h4 className="text-sm font-medium text-slate-900">{title}</h4>
        <button
          type="button"
          data-testid={`${testIdPrefix}-toggle-all`}
          onClick={onToggleAll}
          disabled={disabled || tables.length === 0}
          className={cn(
            'text-xs text-slate-500 transition-colors hover:text-slate-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 rounded',
            'disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:text-slate-300',
          )}
        >
          {allSelected ? 'Deselect all' : 'Select all'}
        </button>
      </div>
      {tables.length === 0 ? (
        <p className="px-3 py-3 text-xs text-slate-400">No tables available.</p>
      ) : (
        <div className="max-h-56 divide-y divide-slate-100 overflow-y-auto">
          {tables.map((t) => {
            const isChecked = selected.has(t.id)
            return (
              <label
                key={t.id}
                data-testid={`${testIdPrefix}-row-${t.id}`}
                className={cn(
                  'flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-slate-50',
                  disabled && 'cursor-not-allowed opacity-60 hover:bg-transparent',
                )}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => onToggle(t.id)}
                  disabled={disabled}
                  data-testid={`${testIdPrefix}-checkbox-${t.id}`}
                  className="cursor-pointer rounded border-slate-300 text-blue-600 focus:ring-2 focus:ring-blue-500/30 disabled:cursor-not-allowed"
                />
                <span className="font-mono text-[13px] text-slate-900">
                  {t.name}
                </span>
                {t.datasetName && (
                  <span className="truncate text-xs text-slate-400">
                    {t.datasetName}
                  </span>
                )}
              </label>
            )
          })}
        </div>
      )}
      <p
        data-testid={`${testIdPrefix}-count`}
        className="border-t border-slate-100 px-3 py-2 text-xs text-slate-400"
      >
        {selectedInTablesCount > 0
          ? `${selectedInTablesCount} of ${tables.length} selected`
          : `${tables.length} table${tables.length !== 1 ? 's' : ''}`}
      </p>
    </div>
  )
}

// ─── GenerateMappingsPanel ───────────────────────────────────────────

export interface GenerateMappingsPanelProps {
  projectId: string
  sourceTables: TableForSelector[]
  targetTables: TableForSelector[]
}

/**
 * Format an elapsed-seconds count as `M:SS`. Counter starts at `0:00` and
 * grows monotonically; we don't need hour-level resolution because the
 * server action returns within minutes (Heritage-scale schemas: 1-3 min).
 */
function formatElapsed(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ─── Rootstock pilot — padded Generate-Mappings timing ───────────────
//
// TODO(kaan, YYYY-MM-DD): Remove after Rootstock pilot completes.
// Padded timing for verbal-disclosed pilot simulation. The Rootstock
// pilot demonstrates how the production agent pipeline will *feel* once
// it lands — production generation is expected to run 3-5 minutes, but
// the current static-config path completes in 20-30s. For the two gated
// projects only, the client holds the (already-resolved) result and
// runs a phased progress UI for a randomized 3-5 minute window so the
// pilot forms an accurate impression of production operations. The
// customer is told verbally that the timing is simulated. Project-gated
// and one-time use — every other project is unaffected.
const PILOT_PADDED_TIMING_PROJECT_IDS = [
  'eba53ac1-3d35-45ba-852d-a3fa3761850b', // Rootstock customer project
  '699fe032-57cb-4f56-a06e-7a2a882f20e1', // Rootstock POC Statis Test (internal demo)
] as const

/** Sequential phase labels shown during the padded pilot simulation. */
const PILOT_PHASE_LABELS = [
  'Profiling source schemas…',
  'Building target field embeddings…',
  'Evaluating candidate pairings…',
  'Detecting multi-source patterns…',
  'Scoring confidence…',
  'Finalizing proposals…',
] as const

/**
 * Fraction of the total padded duration allotted to each of the six
 * phases. Sums to 1.0 — front-loaded lightly on profiling, heaviest on
 * candidate evaluation, shaped to read like a real pipeline.
 */
const PILOT_PHASE_WEIGHTS = [0.1, 0.15, 0.25, 0.2, 0.2, 0.1] as const

const PILOT_MIN_DURATION_MS = 3 * 60_000
const PILOT_MAX_DURATION_MS = 5 * 60_000

/** True when `projectId` is one of the gated Rootstock pilot projects. */
function isPilotPaddedTimingProject(projectId: string): boolean {
  return (PILOT_PADDED_TIMING_PROJECT_IDS as readonly string[]).includes(
    projectId,
  )
}

/**
 * Pick the total padded duration, uniformly random in [3min, 5min].
 * `rand` is injectable so tests can pin the timing deterministically.
 */
export function pickPilotPaddedDurationMs(
  rand: () => number = Math.random,
): number {
  const span = PILOT_MAX_DURATION_MS - PILOT_MIN_DURATION_MS
  return Math.round(PILOT_MIN_DURATION_MS + rand() * span)
}

/**
 * Compute the six phase-transition timestamps (ms from simulation
 * start) for a padded run of `totalMs`. Indices 0-4 are the moments
 * phases 2-6 begin; index 5 is `totalMs` itself — the result handoff.
 *
 * Interior boundaries are placed at the cumulative phase weights, then
 * jittered by up to ±4% of the total so successive runs vary visibly.
 * Boundaries are clamped strictly monotonic and strictly inside
 * (0, totalMs) so phases never reorder or overrun the handoff.
 */
export function computePilotPhaseBoundaries(
  totalMs: number,
  rand: () => number = Math.random,
): number[] {
  const boundaries: number[] = []
  let cumulative = 0
  for (let i = 0; i < PILOT_PHASE_WEIGHTS.length - 1; i += 1) {
    cumulative += PILOT_PHASE_WEIGHTS[i]
    const jitter = (rand() - 0.5) * 0.08 * totalMs
    boundaries.push(cumulative * totalMs + jitter)
  }
  // Clamp strictly monotonic and within (0, totalMs); round to whole
  // milliseconds since these feed `setTimeout` durations directly.
  for (let i = 0; i < boundaries.length; i += 1) {
    const lowerBound = i === 0 ? 1 : boundaries[i - 1] + 1
    boundaries[i] = Math.round(
      Math.min(Math.max(boundaries[i], lowerBound), totalMs - 1),
    )
  }
  boundaries.push(totalMs)
  return boundaries
}

export function GenerateMappingsPanel({
  projectId,
  sourceTables,
  targetTables,
}: GenerateMappingsPanelProps) {
  const router = useRouter()
  const { pushToast } = useToast()

  const [selectedSrc, setSelectedSrc] = useState<Set<string>>(
    () => new Set(sourceTables.map((t) => t.id)),
  )
  const [selectedTgt, setSelectedTgt] = useState<Set<string>>(
    () => new Set(targetTables.map((t) => t.id)),
  )
  // Two-phase overlay state: 'idle' | 'generating' | 'refreshing'.
  // 'generating' covers the await on `generateMappings`. 'refreshing' is a
  // brief window after success while `router.refresh()` rehydrates the
  // server component and the panel unmounts naturally.
  const [phase, setPhase] = useState<'idle' | 'generating' | 'refreshing'>('idle')
  const [elapsedSec, setElapsedSec] = useState(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // ─── Rootstock pilot padded-timing simulation ──────────────────────
  // Gated by project id (see `PILOT_PADDED_TIMING_PROJECT_IDS`). For
  // every other project these stay inert and the flow below is the
  // unchanged pre-pilot behavior.
  const isPilotPaddedTiming = isPilotPaddedTimingProject(projectId)
  const [pilotPhaseIndex, setPilotPhaseIndex] = useState(0)
  // Timers driving the phased progress + the result-handoff deadline.
  const pilotTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])
  // Coordination: the held result renders only once BOTH the server has
  // returned success AND the padded duration has elapsed.
  const pilotServerSucceededRef = useRef(false)
  const pilotDurationElapsedRef = useRef(false)
  const pilotFinalizedRef = useRef(false)

  // Keep elapsed counter ticking while phase === 'generating'. Stop when
  // we transition to 'refreshing' (the user has the success signal at that
  // point — counter has done its job).
  useEffect(() => {
    if (phase === 'generating') {
      setElapsedSec(0)
      intervalRef.current = setInterval(() => {
        setElapsedSec((prev) => prev + 1)
      }, 1000)
      return () => {
        if (intervalRef.current !== null) {
          clearInterval(intervalRef.current)
          intervalRef.current = null
        }
      }
    }
    // For 'idle' and 'refreshing' the interval is not needed; ensure any
    // stale interval is cleared (defense-in-depth — the cleanup above
    // covers the 'generating' → next-phase transition).
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
    return undefined
  }, [phase])

  // Belt-and-suspenders unmount cleanup (covers React strict-mode double-
  // invocation in dev + any path where the panel unmounts mid-generation
  // — e.g. parent re-renders into populated state after a fast refresh).
  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
      // Clear any in-flight pilot simulation timers on unmount.
      for (const id of pilotTimersRef.current) clearTimeout(id)
      pilotTimersRef.current = []
    }
  }, [])

  const isBusy = phase !== 'idle'
  const canGenerate =
    selectedSrc.size > 0 && selectedTgt.size > 0 && !isBusy

  function toggleSrc(id: string) {
    setSelectedSrc((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleTgt(id: string) {
    setSelectedTgt((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllSrc() {
    setSelectedSrc((prev) => {
      const allSelected =
        sourceTables.length > 0 && sourceTables.every((t) => prev.has(t.id))
      if (allSelected) return new Set<string>()
      return new Set(sourceTables.map((t) => t.id))
    })
  }

  function toggleAllTgt() {
    setSelectedTgt((prev) => {
      const allSelected =
        targetTables.length > 0 && targetTables.every((t) => prev.has(t.id))
      if (allSelected) return new Set<string>()
      return new Set(targetTables.map((t) => t.id))
    })
  }

  // ─── Rootstock pilot simulation helpers ────────────────────────────
  // All inert unless `isPilotPaddedTiming` is true. Function declarations
  // (hoisted) so `handleGenerate` below can reference them freely.

  function clearPilotTimers() {
    for (const id of pilotTimersRef.current) clearTimeout(id)
    pilotTimersRef.current = []
  }

  // Render the held result and hand off to the existing post-Generate
  // success flow. No-op until BOTH gates are satisfied; safe to call
  // from either the server-resolution path or the duration-elapsed
  // timer, whichever completes second.
  function finalizePilotGenerationIfReady() {
    if (pilotFinalizedRef.current) return
    if (!pilotServerSucceededRef.current) return
    if (!pilotDurationElapsedRef.current) return
    pilotFinalizedRef.current = true
    clearPilotTimers()
    pushToast({
      id: `generate-mappings-${Date.now()}`,
      variant: 'success',
      message: 'Mappings generated.',
    })
    setPhase('refreshing')
    router.refresh()
  }

  // Kick off the phased progress UI: schedule the five phase advances
  // and the result-handoff deadline across a randomized 3-5 min window.
  function startPilotSimulation() {
    clearPilotTimers()
    setPilotPhaseIndex(0)
    pilotServerSucceededRef.current = false
    pilotDurationElapsedRef.current = false
    pilotFinalizedRef.current = false

    const totalMs = pickPilotPaddedDurationMs()
    const boundaries = computePilotPhaseBoundaries(totalMs)

    // boundaries[0..4]: advance into phases 2-6.
    for (let i = 0; i < PILOT_PHASE_LABELS.length - 1; i += 1) {
      pilotTimersRef.current.push(
        setTimeout(() => setPilotPhaseIndex(i + 1), boundaries[i]),
      )
    }
    // boundaries[5] === totalMs: the result-handoff deadline.
    pilotTimersRef.current.push(
      setTimeout(() => {
        pilotDurationElapsedRef.current = true
        setPilotPhaseIndex(PILOT_PHASE_LABELS.length - 1)
        finalizePilotGenerationIfReady()
      }, boundaries[boundaries.length - 1]),
    )
  }

  async function handleGenerate() {
    if (!canGenerate) return
    setPhase('generating')

    // Rootstock pilot: start the phased progress UI immediately, in
    // parallel with the server request. The result is held client-side
    // until the padded duration elapses. Gated by project id — every
    // other project keeps today's behavior untouched.
    if (isPilotPaddedTiming) {
      startPilotSimulation()
    }

    try {
      const result = await generateMappings(
        projectId,
        Array.from(selectedSrc),
        Array.from(selectedTgt),
      )
      if (!result || result.success !== true) {
        // Error path — surface immediately, no artificial delay, even
        // for gated pilot projects.
        if (isPilotPaddedTiming) clearPilotTimers()
        pushToast({
          id: `generate-mappings-${Date.now()}`,
          variant: 'error',
          message: result?.error ?? 'Could not generate mappings.',
        })
        setPhase('idle')
        return
      }

      if (isPilotPaddedTiming) {
        // Success — hold the result. The handoff (success toast +
        // router.refresh) fires from the duration-elapsed timer via
        // `finalizePilotGenerationIfReady`, whichever resolves last.
        pilotServerSucceededRef.current = true
        finalizePilotGenerationIfReady()
        return
      }

      pushToast({
        id: `generate-mappings-${Date.now()}`,
        variant: 'success',
        message: 'Mappings generated.',
      })
      // Hold the spinner across the refresh window to avoid a flash of
      // "all-unmapped" state between the action resolving and the new TFM
      // rows hydrating. The parent `MappingContent` unmounts this panel
      // once the new data arrives (`counts.total > counts.unmapped`).
      setPhase('refreshing')
      router.refresh()
    } catch (err) {
      if (isPilotPaddedTiming) clearPilotTimers()
      pushToast({
        id: `generate-mappings-${Date.now()}`,
        variant: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'Could not generate mappings.',
      })
      setPhase('idle')
    }
  }

  return (
    <div
      data-testid="generate-mappings-panel"
      className="relative rounded-lg border border-slate-200 bg-white p-5"
    >
      {isBusy && (
        <div
          data-testid="generate-mappings-overlay"
          className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-white/95"
        >
          <div className="px-4 text-center">
            <Loader2
              aria-hidden="true"
              data-testid="generate-mappings-spinner"
              className="mx-auto mb-3 h-10 w-10 animate-spin text-blue-600"
            />
            {phase === 'generating' ? (
              isPilotPaddedTiming ? (
                <>
                  <p
                    data-testid="generate-mappings-status"
                    className="text-sm font-semibold text-slate-900"
                  >
                    Generating AI-powered mappings…
                  </p>
                  <p
                    data-testid="generate-mappings-phase-label"
                    className="mt-1 text-xs text-slate-500"
                  >
                    {PILOT_PHASE_LABELS[pilotPhaseIndex]}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Step {pilotPhaseIndex + 1} of {PILOT_PHASE_LABELS.length}
                  </p>
                  <p
                    data-testid="generate-mappings-elapsed"
                    className="mt-2 font-mono text-xs text-slate-500"
                  >
                    Elapsed: {formatElapsed(elapsedSec)}
                  </p>
                </>
              ) : (
                <>
                  <p
                    data-testid="generate-mappings-status"
                    className="text-sm font-semibold text-slate-900"
                  >
                    Generating AI-powered mappings…
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Analyzing {sourceTables.length} source{' '}
                    {sourceTables.length === 1 ? 'table' : 'tables'} and{' '}
                    {targetTables.length} target{' '}
                    {targetTables.length === 1 ? 'table' : 'tables'}.
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    This typically takes 1-3 minutes.
                  </p>
                  <p
                    data-testid="generate-mappings-elapsed"
                    className="mt-2 font-mono text-xs text-slate-500"
                  >
                    Elapsed: {formatElapsed(elapsedSec)}
                  </p>
                </>
              )
            ) : (
              <p
                data-testid="generate-mappings-status"
                className="text-sm font-semibold text-slate-900"
              >
                Loading mappings…
              </p>
            )}
          </div>
        </div>
      )}

      <div className="mb-5 grid grid-cols-2 gap-5">
        <TableSelector
          title="Source tables"
          testIdPrefix="generate-mappings-source"
          tables={sourceTables}
          selected={selectedSrc}
          onToggle={toggleSrc}
          onToggleAll={toggleAllSrc}
          disabled={isBusy}
        />
        <TableSelector
          title="Target tables"
          testIdPrefix="generate-mappings-target"
          tables={targetTables}
          selected={selectedTgt}
          onToggle={toggleTgt}
          onToggleAll={toggleAllTgt}
          disabled={isBusy}
        />
      </div>

      <div className="flex items-center justify-end">
        <button
          type="button"
          data-testid="generate-mappings-submit"
          onClick={handleGenerate}
          disabled={!canGenerate}
          aria-busy={isBusy}
          className={cn(
            'inline-flex h-9 items-center justify-center gap-2 rounded-md border px-4 text-sm font-medium transition-colors',
            'border-blue-600 bg-blue-600 text-white hover:bg-blue-700',
            'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
            'disabled:cursor-not-allowed disabled:border-slate-200 disabled:bg-slate-100 disabled:text-slate-400 disabled:hover:bg-slate-100',
          )}
        >
          {isBusy ? (
            <>
              <Loader2 aria-hidden="true" className="h-4 w-4 animate-spin" />
              <span>Generating…</span>
            </>
          ) : (
            <span>Generate Mappings</span>
          )}
        </button>
      </div>
    </div>
  )
}
